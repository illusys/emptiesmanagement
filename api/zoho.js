export default async function handler(req, res) {
  // Allow requests from your domain only
  res.setHeader('Access-Control-Allow-Origin', 'https://empties.malexchloglobal.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-URL');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const targetURL = req.headers['x-target-url'];
  if (!targetURL) {
    return res.status(400).json({ error: 'Missing X-Target-URL header' });
  }

  // Only allow Zoho API domains
  const allowed = [
    'https://www.zohoapis.com',
    'https://accounts.zoho.com',
    'https://inventory.zoho.com',
    'https://books.zoho.com'
  ];
  if (!allowed.some(d => targetURL.startsWith(d))) {
    return res.status(403).json({ error: 'Domain not allowed' });
  }

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': req.headers['authorization'],
        'Content-Type': 'application/json;charset=UTF-8'
      }
    };
    if (req.method !== 'GET' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const zohoRes = await fetch(targetURL, fetchOptions);
    const data = await zohoRes.json();
    return res.status(zohoRes.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
