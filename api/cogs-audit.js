/**
 * /api/cogs-audit.js
 *
 * Read-only audit: flags items and open Sales Orders whose GL accounts point
 * to the generic Sales / COGS accounts instead of LOB-specific accounts.
 *
 * GET  /api/cogs-audit          — run both checks, return JSON result
 * GET  /api/cogs-audit?check=items — item master only
 * GET  /api/cogs-audit?check=sos  — open SO drift only
 *
 * Required Zoho scopes (zinventoryconnection2 must have these):
 *   ZohoInventory.items.READ
 *   ZohoInventory.salesorders.READ
 */

const ORG = '921111003';
const INV_BASE = 'https://www.zohoapis.com/inventory/v1';

// Generic / default accounts that should NOT appear on finalised records
const GENERIC_SALES_ID = '8805348000000000388';
const GENERIC_COGS_ID  = '8805348000000034003';

const DELAY_MS = 200;      // pacing between list pages
const BATCH_SIZE = 8;      // concurrent SO detail fetches per batch
const BATCH_PAUSE_MS = 150;// pause between detail batches
const TIME_BUDGET_MS = 230000; // stop fetching SO detail after ~230s so the
                               // function returns before Vercel's 300s cap
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── helpers ──────────────────────────────────────────────────────────────────

function zohoHeaders(token) {
  return {
    Authorization: `Zoho-oauthtoken ${token}`,
    'Content-Type': 'application/json',
  };
}

async function zohoGet(token, path) {
  const url = `${INV_BASE}${path}${path.includes('?') ? '&' : '?'}organization_id=${ORG}`;
  const res = await fetch(url, { headers: zohoHeaders(token) });
  const body = await res.json().catch(() => ({}));
  if (body.code === 57) {
    const err = new Error(`Zoho scope error (code 57): ${body.message || 'not authorized'}. Ensure zinventoryconnection2 has ZohoInventory.items.READ and ZohoInventory.salesorders.READ.`);
    err.code57 = true;
    throw err;
  }
  if (body.code !== 0 && body.code !== undefined) {
    throw new Error(`Zoho API error ${body.code}: ${body.message}`);
  }
  return body;
}

// Paginate any list endpoint; listKey = key in response containing array
async function paginate(token, basePath, listKey, perPage = 200) {
  const results = [];
  for (let page = 1; page <= 50; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const d = await zohoGet(token, `${basePath}${sep}per_page=${perPage}&page=${page}`);
    const items = d[listKey] || [];
    results.push(...items);
    if (items.length < perPage) break;
    await sleep(DELAY_MS);
  }
  return results;
}

// ── Check A: item master ──────────────────────────────────────────────────────

async function checkItems(token) {
  const allItems = await paginate(token, '/items?status=active', 'items');
  const flagged = [];
  for (const item of allItems) {
    const issues = [];
    if (item.account_id === GENERIC_SALES_ID) issues.push('Revenue account → generic Sales');
    if (item.purchase_account_id === GENERIC_COGS_ID) issues.push('Purchase/COGS account → generic COGS');
    if (issues.length) {
      flagged.push({
        item_id: item.item_id,
        item_name: item.name,
        sku: item.sku || '',
        stock_on_hand: item.stock_on_hand ?? 0,
        issues,
        account_id: item.account_id,
        purchase_account_id: item.purchase_account_id,
      });
    }
  }
  return { total_scanned: allItems.length, flagged_count: flagged.length, flagged };
}

// ── Check B: open SO snapshot drift ──────────────────────────────────────────

async function checkSalesOrders(token) {
  // Fetch ALL sales orders (Zoho's status filter enum is fragile across
  // org configs), then keep only those not fully invoiced/closed/void.
  const CLOSED_STATUSES = new Set(['invoiced', 'closed', 'void', 'rejected']);
  const everySO = await paginate(token, '/salesorders', 'salesorders');
  const allSOs = everySO.filter(so => !CLOSED_STATUSES.has((so.status || '').toLowerCase()));

  // Build item master lookup (account_id per item_id)
  const allItems = await paginate(token, '/items?status=active', 'items');
  const itemMap = {};
  for (const item of allItems) {
    itemMap[item.item_id] = { name: item.name, account_id: item.account_id };
  }

  const flaggedLines = [];
  let totalSosScanned = 0;
  const deadline = Date.now() + TIME_BUDGET_MS;

  const scanDetail = (detail, soId) => {
    for (const line of detail.line_items || []) {
      const capturedAccount = line.account_id || '';
      const currentItem = itemMap[line.item_id];
      const currentAccount = currentItem?.account_id || '';

      const capturedIsGeneric =
        capturedAccount === GENERIC_SALES_ID || capturedAccount === GENERIC_COGS_ID;
      const driftDetected =
        currentAccount && capturedAccount && capturedAccount !== currentAccount;

      if (capturedIsGeneric || driftDetected) {
        flaggedLines.push({
          so_number: detail.salesorder_number,
          so_id: soId,
          customer_name: detail.customer_name,
          so_date: detail.date,
          item_id: line.item_id,
          item_name: line.name || currentItem?.name || line.item_id,
          captured_account_id: capturedAccount,
          current_account_id: currentAccount,
          accounts_match: capturedAccount === currentAccount,
          captured_is_generic: capturedIsGeneric,
          quantity: line.quantity,
          unit: line.unit || '',
        });
      }
    }
  };

  // Fetch SO detail in parallel batches (line-item account snapshots aren't in
  // the list response, so each open SO needs its own GET).
  let truncated = false;
  for (let i = 0; i < allSOs.length; i += BATCH_SIZE) {
    if (Date.now() > deadline) { truncated = true; break; }
    const batch = allSOs.slice(i, i + BATCH_SIZE);
    const details = await Promise.all(batch.map(async so => {
      try {
        const d = await zohoGet(token, `/salesorders/${so.salesorder_id}`);
        return { detail: d.salesorder || so, soId: so.salesorder_id };
      } catch (e) {
        return null; // skip individual failures rather than aborting the audit
      }
    }));
    for (const r of details) {
      totalSosScanned++;
      if (r) scanDetail(r.detail, r.soId);
    }
    await sleep(BATCH_PAUSE_MS);
  }

  return {
    total_open_sos: allSOs.length,
    total_sos_scanned: totalSosScanned,
    flagged_line_count: flaggedLines.length,
    flagged_lines: flaggedLines,
    partial: truncated,
  };
}

// ── handler ───────────────────────────────────────────────────────────────────

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://empties.malexchloglobal.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers['authorization'] || '').replace(/^Zoho-oauthtoken\s+/i, '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const check = req.query.check || 'both';

  try {
    const result = { timestamp: new Date().toISOString(), org_id: ORG };

    if (check === 'items' || check === 'both') {
      result.item_master = await checkItems(token);
    }
    if (check === 'sos' || check === 'both') {
      result.open_sales_orders = await checkSalesOrders(token);
    }

    // Summary counts
    result.summary = {
      items_flagged: result.item_master?.flagged_count ?? 0,
      so_lines_at_risk: result.open_sales_orders?.flagged_line_count ?? 0,
      partial: result.open_sales_orders?.partial ?? false,
    };

    return res.status(200).json(result);
  } catch (e) {
    const status = e.code57 ? 403 : 500;
    return res.status(status).json({ error: e.message, scope_error: !!e.code57 });
  }
}
