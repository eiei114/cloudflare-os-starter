import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** The tunnel accepts only this proxy's distinct bearer key, never the Cursor key. */
export function authorized(header, token) {
  const actual = Buffer.from(header ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Loopback-only, fixed-target HTTP/WebSocket gateway for PI WEB. No arbitrary URL forwarding,
 * credential-entry route, body logging, or inference logic. The authenticated Worker supplies
 * the bearer key; the browser never receives it. PI WEB is a trusted-user full-machine runtime,
 * not a sandbox. Do not expose its upstream port through a tunnel.
 */
export function createAuthProxy({ token, upstreamPort = 8504 }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A strong proxy key is required.');
  const server = createServer((request, response) => {
    if (!authorized(request.headers.authorization, token)) {
      response.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Authentication required.'); request.resume(); return;
    }
    const headers = { ...request.headers, host: `127.0.0.1:${upstreamPort}` };
    // The proxy token must not be exposed to PI WEB plugins, diagnostics, or browser responses.
    delete headers.authorization;
    delete headers['proxy-authorization'];
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort,
      path: request.url, method: request.method, headers }, incoming => {
      const outgoingHeaders = { ...incoming.headers, 'cache-control': 'no-store' };
      delete outgoingHeaders['set-cookie'];
      response.writeHead(incoming.statusCode ?? 502, outgoingHeaders);
      incoming.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end('PI WEB is unavailable on the Mac.');
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    if (!authorized(request.headers.authorization, token)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = connect(upstreamPort, '127.0.0.1', () => {
      const headers = { ...request.headers, host: `127.0.0.1:${upstreamPort}` };
      delete headers.authorization; delete headers['proxy-authorization'];
      const wire = Object.entries(headers).flatMap(([name, value]) =>
        Array.isArray(value) ? value.map(item => `${name}: ${item}`) : [`${name}: ${value}`]);
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${wire.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  return server;
}

/** Start the fixed local proxy using its dedicated private credential store. */
export async function startProxy() {
  const state = `${homedir()}/Library/Application Support/eisuke-os-pi-runner`;
  const { token } = JSON.parse(await readFile(`${state}/proxy-auth.json`, 'utf8'));
  const server = createAuthProxy({ token });
  server.listen(47931, '127.0.0.1', () => console.log('PI WEB auth proxy listening on loopback port 47931.'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(); server.closeAllConnections(); process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await startProxy();
