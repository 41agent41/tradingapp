/**
 * Serves the app and forwards `/api` and `/socket.io` to the backend on the
 * same address (see proxy.js), so the page never needs the backend's URL.
 *
 *   node server.js          production (after `next build`)
 *   node server.js --dev    development, with hot reload
 *
 * BACKEND_INTERNAL_URL is where this container reaches the backend; compose
 * sets it. It is read when the server starts, not baked into the build.
 */
const http = require('http');
const next = require('next');
const { createBackendProxy } = require('./proxy');

const dev = process.argv.includes('--dev');
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);
const backendUrl = process.env.BACKEND_INTERNAL_URL || 'http://localhost:4000';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const proxy = createBackendProxy(backendUrl);
    const nextUpgrade =
      typeof app.getUpgradeHandler === 'function' ? app.getUpgradeHandler() : null;

    const server = http.createServer((req, res) => {
      if (proxy.handles(req.url)) proxy.web(req, res);
      else handle(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      if (proxy.handles(req.url)) proxy.ws(req, socket, head);
      else if (nextUpgrade) nextUpgrade(req, socket, head);
      else socket.destroy();
    });
    server.listen(port, hostname, () => {
      console.log(`> frontend on http://${hostname}:${port}, API forwarded to ${backendUrl}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
