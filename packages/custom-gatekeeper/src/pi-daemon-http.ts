import { createRemoteJWKSet, jwtVerify } from 'jose';
import { digest, callCoordinator, type PiCoordinator } from './pi-coordinator.js';
import type { PiConsoleEnv } from './pi-console.js';

export type DaemonEnv = PiConsoleEnv & {
  PI_DAEMON_ENABLED?: boolean;
  PI_COORDINATOR?: DurableObjectNamespace<PiCoordinator>;
};
const prefix = '/gatekeeper/custom/runner/';
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

/** Separate device bearer and verified owner JWT surfaces. No ambient browser auth on device routes. */
export async function fetchPiDaemon(req: Request, env: DaemonEnv): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(prefix)) return undefined;
  if (!env.PI_DAEMON_ENABLED || !env.PI_COORDINATOR) return json({ error: 'Daemon disabled' }, 503);
  if (url.origin !== env.PUBLIC_BASE_URL || url.search) return json({ error: 'Invalid origin' }, 403);
  const op = url.pathname.slice(prefix.length);
  const deviceOps = ['pair', 'catalog', 'claim', 'heartbeat', 'finish'];
  const ownerOps = ['', 'pair-code', 'inventory', 'revoke'];
  if (![...deviceOps, ...ownerOps].includes(op)) return json({ error: 'Not found' }, 404);
  if (req.method !== (op === '' ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
  try {
    let auth: { owner?: boolean; hash?: string } = {};
    if (ownerOps.includes(op)) {
      if (!env.CF_ACCESS_ISS || !env.CF_ACCESS_AUD || !env.ADMINS?.length ||
          (op !== '' && req.headers.get('origin') !== env.PUBLIC_BASE_URL) ||
          (req.headers.has('origin') && req.headers.get('origin') !== env.PUBLIC_BASE_URL))
        return json({ error: 'Owner origin required' }, 403);
      const token = req.headers.get('cf-access-jwt-assertion');
      if (!token) return json({ error: 'Owner authentication required' }, 401);
      const issuer = env.CF_ACCESS_ISS.replace(/\/$/, '');
      let jwks = keys.get(issuer);
      if (!jwks) { jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keys.set(issuer, jwks); }
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.CF_ACCESS_AUD,
        algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email'] });
      if (typeof payload.email !== 'string' || !env.ADMINS.includes(payload.email)) return json({ error: 'Owner only' }, 403);
      auth = { owner: true };
    } else {
      // Pair is one-use, high-entropy authentication; all other calls require the device credential.
      if (req.headers.has('origin') || req.headers.has('cookie')) return json({ error: 'Device route only' }, 403);
      if (op !== 'pair') {
        const token = req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token) return json({ error: 'Device authentication required' }, 401);
        auth.hash = await digest(token);
      }
    }
    if (op === '') return portal();
    if (req.headers.get('content-type') !== 'application/json') return json({ error: 'JSON required' }, 415);
    // Stream-bound input: Content-Length is untrusted and may be absent.
    const reader = req.body?.getReader();
    let bytes = 0; const chunks: Uint8Array[] = [];
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 100_000) { await reader.cancel(); return json({ error: 'Too large' }, 413); }
      chunks.push(value);
    }
    const buffer = new Uint8Array(bytes); let offset = 0;
    for (const c of chunks) { buffer.set(c, offset); offset += c.length; }
    const data = JSON.parse(new TextDecoder().decode(buffer));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Invalid body' }, 400);
    if (op === 'pair-code') {
      const code = randomToken();
      const result = await callCoordinator(env, op, { ...data, hash: await digest(code) }, auth);
      return json({ ...result, code });
    }
    if (op === 'pair') {
      if (typeof data.code !== 'string' || !/^[a-f0-9]{64}$/.test(data.code)) return json({ error: 'Invalid code' }, 401);
      const token = randomToken();
      const result = await callCoordinator(env, op, { codeHash: await digest(data.code),
        id: crypto.randomUUID(), tokenHash: await digest(token) }, {});
      return json({ ...result, token });
    }
    // Never let request data select owner authority or change its token identity.
    return json(await callCoordinator(env, op, data, auth));
  } catch {
    // Do not expose prompts, tokens, provider errors or private stack traces.
    return json({ error: 'Request rejected' }, 400);
  }
}
function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
}

function portal(): Response {
  const nonce = randomToken();
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Local Pi devices</title><h1>Local Pi devices — owner only</h1>
<p>Pair once per computer. Pi runs with your normal local account authority, not a sandbox. Never copy model keys here.</p>
<label>Device label <input id="label" maxlength="80"></label>
<label>Platform <select id="platform"><option>darwin</option><option>win32</option></select></label>
<button id="pair">Create 5-minute one-use code</button><pre id="code"></pre>
<button id="refresh">Refresh devices and project URLs</button><pre id="inventory"></pre>
<label>Device ID to revoke <input id="device"></label><button id="revoke">Revoke device</button><p id="message"></p>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);
async function call(op,data){const r=await fetch('./'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error('Request rejected');return v;}
async function refresh(){const v=await call('inventory',{});el('inventory').textContent=JSON.stringify({devices:v.devices,projects:v.projects.map(p=>({...p,url:'pi-project://projects/'+p.id}))},null,2);}
function on(id,fn){el(id).onclick=()=>fn().catch(()=>el('message').textContent='Request rejected.');}
on('pair',async()=>{const v=await call('pair-code',{label:el('label').value,platform:el('platform').value});el('code').textContent=v.code;setTimeout(()=>el('code').textContent='',300000);});
on('refresh',refresh);on('revoke',async()=>{if(!confirm('Revoke this device? Running tasks become uncertain. Inspect local side effects.'))return;await call('revoke',{deviceId:el('device').value});await refresh();});
</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}
