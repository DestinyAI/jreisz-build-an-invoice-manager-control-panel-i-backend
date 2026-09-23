// Custom backend for invoicer-1.
// Run: node server.js
// Expose publicly: cloudflared tunnel --url http://localhost:3000
const http = require('http');

const PORT = process.env.PORT || 3000;

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/ping') {
    return json(res, 200, { ok: true, app: 'invoicer-1' });
  }

  // Add your routes here.

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => console.log(`invoicer-1 backend running at http://localhost:${PORT}`));
