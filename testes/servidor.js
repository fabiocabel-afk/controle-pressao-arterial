// Servidor estático mínimo para testar o app em http://localhost:8765/
const http = require('http'), fs = require('fs'), path = require('path');
const raiz = path.join(__dirname, '..', 'app');
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const arq = path.join(raiz, path.normalize(p));
  if (!arq.startsWith(raiz)) { res.writeHead(403); return res.end(); }
  fs.readFile(arq, (e, d) => { if (e) { res.writeHead(404); return res.end('não encontrado'); } res.writeHead(200, { 'Content-Type': tipos[path.extname(arq)] || 'application/octet-stream' }); res.end(d); });
}).listen(8765, () => console.log('servindo', raiz, 'em http://localhost:8765/'));
