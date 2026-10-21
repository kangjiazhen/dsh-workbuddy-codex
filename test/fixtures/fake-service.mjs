/**
 * Minimal stand-in for a supervised service, used by the autostart smoke test.
 * Listens on the port given as argv[2] and answers 200 on every path.
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 0);
const status = Number(process.argv[3] ?? 200);

createServer((req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: status === 200, path: req.url, pid: process.pid }));
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening on ${port}\n`);
});
