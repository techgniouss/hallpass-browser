// Serves a JSON map { "/path": "<html>" } so detection fixtures can be loaded by a real browser from another process.
import http from 'node:http';
import fs from 'node:fs';

const routes = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const html = routes[p];
  res.writeHead(html === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html === undefined ? '<title>404</title>not found' : html);
});
server.listen(0, () => process.stdout.write(String(server.address().port) + '\n'));
process.stdin.resume();
process.stdin.on('end', () => { server.close(); process.exit(0); });
