// Tiny license gate (sidecar). Fronts ONE service: checks the license on every request,
// then transparently proxies to the app on localhost. No external dependencies.
//
//   LISTEN_PORT    port the gate listens on (reached by the edge Caddy)        default 8080
//   UPSTREAM_HOST  where the real app listens (same netns -> 127.0.0.1)        default 127.0.0.1
//   UPSTREAM_PORT  the real app's port                                         default 8000
const http = require('node:http');
const { getStatus } = require('./verify');

const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8080);
const UPSTREAM_HOST = process.env.UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT || 8000);

const server = http.createServer((req, res) => {
  const s = getStatus();
  if (!s.valid) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'LICENSE_INVALID', code: s.code, message: s.message }));
    return;
  }
  const proxyReq = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, 'x-license-status': s.code, 'x-license-expires': s.expiresAt || '' },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'UPSTREAM_UNAVAILABLE', message: e.message }));
  });
  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, '0.0.0.0', () =>
  console.log(`license-gate listening on :${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`),
);
