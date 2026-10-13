import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { authorized, createAuthProxy } from './auth-proxy.mjs';

const token = 'test-token-long-enough-for-private-proxy';

test('authentication fails closed', () => {
  assert.equal(authorized(undefined, token), false);
  assert.equal(authorized(`Bearer ${token.slice(0, -1)}`, token), false);
  assert.equal(authorized(`Bearer ${token}`, token), true);
  assert.throws(() => createAuthProxy({ token: '' }));
});

test('WebSocket upgrades require the proxy key and strip it from the upstream handshake', async () => {
  const upstream = createServer();
  const sockets = new Set();
  upstream.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    assert.equal(req.url, '/api/socket');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['proxy-authorization'], undefined);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', chunk => socket.write(chunk));
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createAuthProxy({ token, upstreamPort: upstream.address().port });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const handshake = authorization => new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port: proxy.address().port, path: '/api/socket',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'proxy-authorization': 'private',
        ...(authorization ? { authorization } : {}) } });
    client.setTimeout(3000, () => client.destroy(new Error('Handshake timeout')));
    client.on('error', reject);
    client.on('response', response => { response.resume(); resolve(response.statusCode); });
    client.on('upgrade', (response, socket) => {
      socket.setTimeout(3000, () => socket.destroy(new Error('Echo timeout')));
      socket.on('error', reject);
      socket.once('data', data => { assert.equal(data.toString(), 'ws-echo');
        socket.destroy(); resolve(response.statusCode); });
      socket.write('ws-echo');
    });
    client.end();
  });
  try {
    assert.equal(await handshake(), 401);
    assert.equal(await handshake('Bearer wrong'), 401);
    assert.equal(await handshake(`Bearer ${token}`), 101);
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.close(); proxy.closeAllConnections(); upstream.close(); upstream.closeAllConnections();
  }
});

test('proxy rejects anonymous requests and removes credentials before fixed-target forwarding', async () => {
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('set-cookie', 'must-not-leak=1');
    res.end(req.url);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const proxy = createAuthProxy({ token, upstreamPort: upstream.address().port });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const url = `http://127.0.0.1:${proxy.address().port}`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(`${url}/api/projects`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(await response.text(), '/api/projects');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    proxy.close(); proxy.closeAllConnections(); upstream.close(); upstream.closeAllConnections();
  }
});
