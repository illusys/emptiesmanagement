export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://empties.malexchloglobal.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-URL, X-Org-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const targetURL = req.headers['x-target-url'];
  if (!targetURL) {
    return res.status(400).json({ error: 'Missing X-Target-URL header' });
  }

  const allowed = [
    'https://www.zohoapis.com',
    'https://inventory.zoho.com',
    'https://books.zoho.com',
    'https://accounts.zoho.com',
  ];
  if (!allowed.some(d => targetURL.startsWith(d))) {
    return res.status(403).json({ error: 'Domain not allowed: ' + targetURL.split('/')[2] });
  }

  // Log the outgoing request for debugging
  console.log('Proxy forwarding:', req.method, targetURL);

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'Authorization': req.headers['authorization'],
        'Content-Type': 'application/json;charset=UTF-8',
      }
    };
    if (req.method !== 'GET' && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const zohoRes = await fetch(targetURL, fetchOptions);
    const text = await zohoRes.text();
    
    // Log response for debugging
    console.log('Zoho response status:', zohoRes.status, 'body preview:', text.slice(0, 200));
    
    let data;
    try { data = JSON.parse(text); } 
    catch(e) { data = { raw: text }; }
    
    return res.status(zohoRes.status).json(data);
  } catch (e) {
    console.log('Proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
