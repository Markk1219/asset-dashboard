const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3100;

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  const symbol = decodeURIComponent(req.url.replace('/', '').split('?')[0]);
  if (!symbol) { res.writeHead(400); res.end('missing symbol'); return; }

  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0' } };

  https.get(url, opts, r => {
    let body = '';
    r.on('data', c => body += c);
    r.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(body);
    });
  }).on('error', e => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  });
}).listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
