import http from 'node:http';
import { readFile } from 'node:fs/promises';
import handler from './api/transfer.js';
const types = { 'index.html':'text/html', 'style.css':'text/css', 'app.js':'text/javascript', 'favicon.svg':'image/svg+xml' };
http.createServer(async (req,res) => {
  res.status = code => { res.statusCode=code; return res; };
  res.json = data => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)); };
  const path = new URL(req.url,'http://localhost').pathname;
  if (path === '/api/transfer') {
    let body = '', bytes=0;
    for await (const chunk of req) { bytes+=chunk.length; if (bytes>3000000) { res.status(413).json({error:'Transfer too large.'}); return; } body+=chunk; }
    req.body=body; return handler(req,res);
  }
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!types[file]) { res.statusCode=404; res.end('Not found'); return; }
  res.setHeader('Content-Type',types[file]); res.end(await readFile(new URL(`./public/${file}`,import.meta.url)));
}).listen(3000,'0.0.0.0',() => console.log('PocketDrop: http://localhost:3000 (configure .env.local for transfers)'));
