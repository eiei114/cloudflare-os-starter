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
  const path = url.pathname.slice(prefix.length);
  const isDevice = path.startsWith('device/');
  const op = isDevice ? path.slice('device/'.length) : path;
  const deviceOps = ['pair', 'catalog', 'claim', 'heartbeat', 'finish'];
  const ownerOps = ['', 'pair-code', 'inventory', 'revoke', 'tasks', 'task', 'submit', 'cancel'];
  if (!(isDevice ? deviceOps : ownerOps).includes(op)) return json({ error: 'Not found' }, 404);
  if (req.method !== (op === '' ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
  try {
    let auth: { owner?: boolean; hash?: string } = {};
    if (!isDevice) {
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
      if (req.headers.get('origin')) return json({ error: 'Browser origin forbidden' }, 403);
      if (req.headers.get('cookie')) return json({ error: 'Browser cookies forbidden' }, 403);
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
    if (op === 'submit') {
      // Human-only approval surface, not an agent API or device capability.
      // Ignore caller-supplied source/auth fields. Agent submissions still use ApprovalQueue.
      if (data.approved !== true) return json({ error: 'Explicit owner approval required' }, 400);
      const task = await callCoordinator(env, 'enqueue', { id: data.id, projectId: data.projectId,
        prompt: data.prompt, model: data.model, source: 'owner-ui' }, auth);
      return json({ id: task.id, projectId: task.projectId, status: task.status });
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
<title>Cloudflare OS — Pi tasks</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}label{display:block;margin:.6rem 0}button{margin:.4rem;padding:.6rem}textarea{display:block;width:95%;min-height:8rem}table{border-collapse:collapse;width:100%}td,th{padding:.5rem;text-align:left;border-bottom:1px solid #999}pre{white-space:pre-wrap;overflow-wrap:anywhere}input,select{padding:.4rem}summary{cursor:pointer}#message{min-height:1.5rem}</style>
<h1>Cloudflare OS — Pi tasks</h1>
<p>Manage tasks here. Your registered computer runs native Pi in the background. This does not migrate Multica tasks.</p>
<section aria-labelledby="create-title"><h2 id="create-title">Create task</h2>
<label>Registered project <select id="project"></select></label>
<label>Allowed model <select id="model"></select></label>
<label>Task prompt <textarea id="prompt" maxlength="32000"></textarea></label>
<p>Approval runs Pi with this computer's normal filesystem, network, extensions and provider authority. Not a sandbox. Prompts and final answers are stored in Cloudflare. Provider charges may apply.</p>
<button id="submit">Approve and run task</button></section>
<p id="message" role="status"></p>
<section aria-labelledby="tasks-title"><h2 id="tasks-title">Tasks</h2><button id="tasks-refresh">Refresh tasks</button>
<p>100 retained tasks maximum in this MVP. No automatic retry of uncertain tasks; inspect the execution computer. Cancellation does not undo side effects.</p>
<table><thead><tr><th scope="col">Task / project</th><th scope="col">Status / progress</th><th scope="col">Model / approval</th><th scope="col">Actions</th></tr></thead><tbody id="tasks"></tbody></table>
<h3>Selected task result</h3><pre id="result" aria-live="polite"></pre></section>
<details><summary>Devices and pairing</summary><h2>Local Pi devices — owner only</h2>
<p>Pair once per computer. Pi runs with your normal local account authority, not a sandbox. Never copy model keys here.</p>
<label>Device label <input id="label" maxlength="80"></label>
<label>Platform <select id="platform"><option>darwin</option><option>win32</option></select></label>
<button id="pair">Create 5-minute one-use code</button><pre id="code"></pre>
<button id="refresh">Refresh devices and project URLs</button><pre id="inventory"></pre>
<label>Device ID to revoke <input id="device"></label><button id="revoke">Revoke device</button></details>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);
let projects=[],submissionId=null;
async function call(op,data){const r=await fetch('./'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error('Request rejected');return v;}
function option(select,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}
function models(reset=true){const selected=el('model').value;el('model').replaceChildren();for(const m of projects.find(p=>p.id===el('project').value)?.models||[])option(el('model'),m,m);if(!reset&&[...el('model').options].some(o=>o.value===selected))el('model').value=selected;if(reset)submissionId=null;}
async function refresh(){const v=await call('inventory',{});projects=v.projects.filter(p=>v.devices.some(d=>d.id===p.deviceId&&!d.revoked));el('inventory').textContent=JSON.stringify({devices:v.devices,projects:v.projects.map(p=>({...p,url:'pi-project://projects/'+p.id}))},null,2);
const selected=el('project').value;el('project').replaceChildren();for(const p of projects)option(el('project'),p.id,p.alias+' — '+v.devices.find(d=>d.id===p.deviceId)?.label);if(projects.some(p=>p.id===selected))el('project').value=selected;models(false);await tasks();}
async function tasks(){const v=await call('tasks',{});el('tasks').replaceChildren();for(const t of v.tasks){const row=document.createElement('tr');const p=projects.find(p=>p.id===t.projectId);for(const value of [t.id+' / '+(p?.alias||t.projectId),t.status+' / '+(t.progress||'—'),t.model+' / '+(t.source||'os-approval')]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}const actions=document.createElement('td');
const show=document.createElement('button');show.textContent='View result';show.onclick=()=>view(t).catch(rejected);actions.append(show);
if(['queued','running','cancel-requested'].includes(t.status)){const cancel=document.createElement('button');cancel.textContent='Request cancellation';cancel.onclick=async()=>{if(!confirm('Cancel task '+t.id+'? Completed side effects cannot be undone.'))return;try{await call('cancel',{id:t.id,projectId:t.projectId});await tasks();await view(t);}catch{rejected();}};actions.append(cancel);}row.append(actions);el('tasks').append(row);}}
async function view(t){const v=await call('task',{id:t.id,projectId:t.projectId});el('result').textContent=JSON.stringify(v,null,2);}
function rejected(){el('message').textContent='Request rejected. Refresh state before retrying.';}
function on(id,fn){el(id).onclick=()=>fn().catch(()=>el('message').textContent='Request rejected.');}
el('project').onchange=()=>models();el('model').onchange=el('prompt').oninput=()=>submissionId=null;
on('submit',async()=>{const projectId=el('project').value,model=el('model').value,prompt=el('prompt').value;
if(!projectId||!model||!prompt.trim())return el('message').textContent='Choose a project and model, then enter a task.';
if(new TextEncoder().encode(prompt).length>32000)return el('message').textContent='Prompt exceeds 32,000 UTF-8 bytes.';
if(!confirm('Approve execution on '+el('project').selectedOptions[0].textContent+' using '+model+'? Pi can modify files and call external services.'))return;
submissionId??=crypto.randomUUID();for(const id of ['submit','project','model','prompt','refresh'])el(id).disabled=true;try{const t=await call('submit',{id:submissionId,projectId,model,prompt,approved:true});submissionId=null;el('prompt').value='';el('message').textContent='Task '+t.id+' queued. The registered computer must be online.';await tasks();}finally{for(const id of ['submit','project','model','prompt','refresh'])el(id).disabled=false;}});
on('tasks-refresh',tasks);
on('pair',async()=>{const v=await call('pair-code',{label:el('label').value,platform:el('platform').value});el('code').textContent=v.code;setTimeout(()=>el('code').textContent='',300000);});
on('refresh',refresh);on('revoke',async()=>{if(!confirm('Revoke this device? Running tasks become uncertain. Inspect local side effects.'))return;await call('revoke',{deviceId:el('device').value});await refresh();});
refresh().catch(rejected);
setInterval(()=>{if(!document.hidden)tasks().catch(rejected);},10000);
</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}
