import { createRemoteJWKSet, jwtVerify } from 'jose';
import { digest, callCoordinator, type PiCoordinator } from './pi-coordinator.js';
import type { PiConsoleEnv } from './pi-console.js';

export type DaemonEnv = PiConsoleEnv & {
  PI_DAEMON_ENABLED?: boolean;
  PI_DAEMON_ACCESS_AUD?: string;
  PI_COORDINATOR?: DurableObjectNamespace<PiCoordinator>;
};
const prefix = '/gatekeeper/custom/runner/';
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function accessKeys(issuer: string) {
  let jwks = keys.get(issuer);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keys.set(issuer, jwks); }
  return jwks;
}
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
  const ownerOps = ['', 'pair-code', 'inventory', 'revoke', 'tasks', 'task', 'submit', 'cancel', 'review'];
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
      const { payload } = await jwtVerify(token, accessKeys(issuer), { issuer, audience: env.CF_ACCESS_AUD,
        algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email'] });
      if (typeof payload.email !== 'string' || !env.ADMINS.includes(payload.email)) return json({ error: 'Owner only' }, 403);
      auth = { owner: true };
    } else {
      // Pair is one-use, high-entropy authentication; all other calls require the device credential.
      if (req.headers.get('origin')) return json({ error: 'Browser origin forbidden' }, 403);
      const cookie = req.headers.get('cookie');
      // Access injects CF_Authorization into service requests before Worker delivery.
      // Never authenticate by cookie. Accept only that edge cookie, backed by a signed
      // service assertion for the separate device app; owner/browser JWTs do not qualify.
      if (cookie && cookie.split(';').some(part => part.trim().split('=')[0] !== 'CF_Authorization'))
        return json({ error: 'Browser cookies forbidden' }, 403);
      if (env.PI_DAEMON_ACCESS_AUD) {
        const assertion = req.headers.get('cf-access-jwt-assertion');
        if (!assertion || !env.CF_ACCESS_ISS) return json({ error: 'Service authentication required' }, 401);
        const issuer = env.CF_ACCESS_ISS.replace(/\/$/, '');
        const { payload } = await jwtVerify(assertion, accessKeys(issuer), { issuer, audience: env.PI_DAEMON_ACCESS_AUD,
          algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'common_name'] });
        if (typeof payload.common_name !== 'string' || !payload.common_name || payload.email !== undefined)
          return json({ error: 'Service identity required' }, 403);
      } else if (cookie) return json({ error: 'Browser cookies forbidden' }, 403);
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
        prompt: data.prompt, model: data.model, title: data.title, source: 'owner-ui' }, auth);
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
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>タスクボード — Cloudflare OS</title>
<style nonce="${nonce}">
*{box-sizing:border-box}body{font:15px/1.6 system-ui;color:#18212f;background:#f5f7fa;margin:0;padding:2rem;max-width:1600px;margin-inline:auto}h1,h2,h3{line-height:1.3}header{border-left:5px solid #ee6b22;padding-left:1rem}header p{color:#526074}a{color:#a83e08}label{display:block;margin:.6rem 0}button{font:inherit;border:1px solid #cbd2dd;border-radius:7px;background:white;padding:.55rem .8rem;cursor:pointer}button:hover{background:#edf1f8}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #e46420;outline-offset:2px}button:disabled{cursor:wait;opacity:.6}input,select,textarea{font:inherit;padding:.6rem;border:1px solid #bec8d6;border-radius:6px;max-width:100%;background:white}textarea{display:block;width:100%;min-height:7rem}summary{cursor:pointer;font-weight:600}.compose{background:white;padding:1rem 1.4rem;border:1px solid #dce2eb;border-radius:12px;margin:1.5rem 0}.fields{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.hint{font-size:.85rem;color:#526074}.primary{background:#c94c0c;color:white;border-color:#c94c0c}.primary:hover{background:#a83e08}#message{min-height:1.5rem}.board-scroll{overflow-x:auto;padding-bottom:1rem}.board{display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:1rem;min-width:1240px}.column{background:#e9edf3;border:1px solid #d7deea;border-radius:10px;padding:.75rem;min-height:14rem}.column h3{font-size:1rem;display:flex;justify-content:space-between;gap:.5rem;margin:.3rem 0 1rem}.count{font-size:.8rem;border-radius:20px;background:white;padding:0 .6rem}.card{background:white;border:1px solid #d4dce8;border-radius:9px;padding:1rem;margin-bottom:.75rem;box-shadow:0 2px 5px #18212f0a;overflow-wrap:anywhere}.card h4{font-size:1rem;margin:0 0 .7rem}.card p{margin:.35rem 0}.meta,.task-id{font-size:.78rem;color:#526074}.badge{font-size:.78rem;background:#edf1f8;border-radius:5px;padding:.15rem .45rem;display:inline-block}.card .actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.8rem}.card button{font-size:.8rem;padding:.35rem .6rem}.empty{color:#657389;font-size:.9rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:1rem;border-radius:8px;border:1px solid #dce2eb}#result:empty{display:none}details.devices{margin-top:2rem;padding:1rem;background:white;border:1px solid #dce2eb;border-radius:10px}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:1rem}@media(max-width:700px){body{padding:1rem}.fields{grid-template-columns:1fr;gap:0}.compose{padding:1rem}}
</style>
<header><h1>Cloudflare OS <span class="hint">/ タスクボード</span></h1>
<p>ここでタスクを作成・承認・確認。登録端末のPiが裏で実行します。<a href="/">OSホーム</a></p></header>
<details class="compose" open><summary>新しいタスク</summary><section aria-labelledby="create-title"><h2 id="create-title">タスクを作成</h2>
<label>タイトル <input id="title" maxlength="100" placeholder="例：ログイン画面の表示を直す"></label>
<div class="fields"><label>実行先プロジェクト <select id="project"></select></label>
<label>モデル <select id="model"></select></label></div>
<label>指示 <textarea id="prompt" maxlength="32000" placeholder="何をしてほしいか、完了条件を書いてください"></textarea></label>
<p class="hint">Piは端末の通常の設定・認証・拡張・ファイル操作権限を使います。サンドボックスではありません。指示と最終回答はCloudflareに保存され、モデルの利用料金が発生する場合があります。</p>
<button class="primary" id="submit">承認して実行待ちに追加</button></section></details>
<p id="message" role="status"></p>
<section aria-labelledby="tasks-title"><div class="toolbar"><h2 id="tasks-title">タスク</h2><button id="tasks-refresh">ボードを更新</button></div>
<p class="hint">10秒ごとに更新。端末は起動・接続が必要です。現在の保存上限は100件。結果が不確定なタスクは自動再実行せず、端末側で確認してください。取消は実行済みの変更を元に戻しません。既存Multicaのタスクは別管理です。</p>
<div class="board-scroll" tabindex="0" aria-label="タスクボード。横スクロールできます"><div class="board" id="tasks"></div></div>
<h3 id="result-title">カードを選んで結果を確認</h3><pre id="result" aria-live="polite"></pre></section>
<details class="devices"><summary>実行端末と接続設定</summary><h2>端末の登録 — 所有者専用</h2>
<p class="hint">端末ごとに一度だけ登録します。モデルのAPIキーはここへ入力しないでください。</p>
<label>端末名 <input id="label" maxlength="80"></label>
<label>OS <select id="platform"><option>darwin</option><option>win32</option></select></label>
<button id="pair">5分間有効な登録コードを作成</button><button id="copy-code">登録コードをコピー</button><pre id="code"></pre>
<button id="refresh">端末とプロジェクトを更新</button><pre id="inventory"></pre>
<label>登録を解除する端末ID <input id="device"></label><button id="revoke">端末登録を解除</button></details>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);
let projects=[],submissionId=null,snapshot='',selectedTask=null;
async function call(op,data){const r=await fetch('./'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error('Request rejected');return v;}
function option(select,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}
function models(reset=true){const selected=el('model').value;el('model').replaceChildren();for(const m of projects.find(p=>p.id===el('project').value)?.models||[])option(el('model'),m,m);if(!reset&&[...el('model').options].some(o=>o.value===selected))el('model').value=selected;if(reset)submissionId=null;}
async function refresh(){const v=await call('inventory',{});projects=v.projects.filter(p=>v.devices.some(d=>d.id===p.deviceId&&!d.revoked));el('inventory').textContent=JSON.stringify({devices:v.devices,projects:v.projects.map(p=>({...p,url:'pi-project://projects/'+p.id}))},null,2);
const selected=el('project').value;el('project').replaceChildren();for(const p of projects)option(el('project'),p.id,p.alias+' — '+v.devices.find(d=>d.id===p.deviceId)?.label);if(projects.some(p=>p.id===selected))el('project').value=selected;models(false);snapshot='';await tasks();}
const columns=[['queued','実行待ち'],['running','実行中'],['review','確認待ち'],['done','完了'],['attention','停止・要対応']];
const statuses={queued:'実行待ち',running:'実行中','cancel-requested':'取消依頼中',completed:'実行完了',failed:'失敗',cancelled:'取消済み',uncertain:'結果不確定'};
const stages={starting:'起動中',thinking:'応答生成中',tool:'ツール実行中',settled:'応答確定',stopping:'停止中'};
const column=t=>t.status==='completed'?(t.reviewedAt?'done':'review'):['running','cancel-requested'].includes(t.status)?'running':t.status==='queued'?'queued':'attention';
const taskTitle=t=>t.title||'タスク '+t.id.slice(0,8);
function node(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function action(parent,label,t,fn){const b=node('button',label);b.setAttribute('aria-label',taskTitle(t)+'：'+label);b.onclick=()=>fn().catch(rejected);parent.append(b);}
async function tasks(){const v=await call('tasks',{});const next=JSON.stringify(v.tasks);if(next===snapshot)return;snapshot=next;el('tasks').replaceChildren();
for(const [key,label] of columns){const section=node('section',undefined,'column');section.dataset.column=key;section.setAttribute('aria-label',label);const items=v.tasks.filter(t=>column(t)===key);const heading=node('h3',label);heading.append(node('span',String(items.length),'count'));section.append(heading);
for(const t of items){const card=node('article',undefined,'card');card.dataset.taskId=t.id;card.setAttribute('aria-label',taskTitle(t));card.append(node('h4',taskTitle(t)));card.append(node('p',projects.find(p=>p.id===t.projectId)?.alias||t.projectId,'meta'));card.append(node('p',(statuses[t.status]||t.status)+(t.progress&&['running','cancel-requested'].includes(t.status)?' · '+(stages[t.progress]||t.progress):''),'badge'));card.append(node('p',t.model,'meta'));card.append(node('p',t.source==='owner-ui'?'手動承認':'OS Agent承認','meta'));card.append(node('p',t.id,'task-id'));const buttons=node('div',undefined,'actions');action(buttons,'結果を見る',t,()=>view(t));
if(['queued','running','cancel-requested'].includes(t.status))action(buttons,'取消を依頼',t,async()=>{if(!confirm(taskTitle(t)+'を取り消しますか？ 実行済みの変更は元に戻りません。'))return;await call('cancel',{id:t.id,projectId:t.projectId});await tasks();await view(t);});
if(t.status==='completed'&&!t.reviewedAt)action(buttons,'確認して完了',t,async()=>{await view(t);if(!confirm(taskTitle(t)+'の結果を確認済みとして完了に移しますか？'))return;await call('review',{id:t.id,projectId:t.projectId});await tasks();});
card.append(buttons);section.append(card);}if(!items.length)section.append(node('p','タスクはありません','empty'));el('tasks').append(section);}
if(selectedTask)await view(selectedTask);}
async function view(t){selectedTask=t;const v=await call('task',{id:t.id,projectId:t.projectId});el('result-title').textContent=taskTitle(t)+' — '+(statuses[v?.status]||'結果を取得できません');el('result').textContent=JSON.stringify(v,null,2);}
function rejected(){el('message').textContent='処理が拒否されました。状態を更新してから確認してください。';}
function on(id,fn){el(id).onclick=()=>fn().catch(rejected);}
el('project').onchange=()=>models();el('title').oninput=el('model').onchange=el('prompt').oninput=()=>submissionId=null;
on('submit',async()=>{const projectId=el('project').value,model=el('model').value,prompt=el('prompt').value,title=el('title').value.trim()||undefined;
if(!projectId||!model||!prompt.trim())return el('message').textContent='プロジェクトとモデルを選び、指示を入力してください。';
if(new TextEncoder().encode(prompt).length>32000||title&&new TextEncoder().encode(title).length>200)return el('message').textContent='指示は32,000 UTF-8 bytes、タイトルは200 bytes以内にしてください。';
if(!confirm(el('project').selectedOptions[0].textContent+'で '+model+'を使って実行しますか？ Piにはファイル変更・外部サービスの操作権限があります。'))return;
submissionId??=crypto.randomUUID();for(const id of ['submit','title','project','model','prompt','refresh'])el(id).disabled=true;try{const t=await call('submit',{id:submissionId,projectId,model,prompt,title,approved:true});submissionId=null;el('prompt').value='';el('title').value='';el('message').textContent='タスク '+t.id+'を実行待ちに追加しました。';await tasks();}finally{for(const id of ['submit','title','project','model','prompt','refresh'])el(id).disabled=false;}});
on('tasks-refresh',tasks);
on('pair',async()=>{const v=await call('pair-code',{label:el('label').value,platform:el('platform').value});el('code').textContent=v.code;el('message').textContent='登録コードを作成しました。秘密のまま端末へ入力してください。';setTimeout(()=>el('code').textContent='',300000);});
on('copy-code',async()=>{if(!el('code').textContent)return;await navigator.clipboard.writeText(el('code').textContent);el('message').textContent='登録コードをコピーしました。使用後はクリップボードを消してください。';});
on('refresh',refresh);on('revoke',async()=>{if(!confirm('端末登録を解除しますか？ 実行中のタスクは不確定となり、端末側の確認が必要です。'))return;await call('revoke',{deviceId:el('device').value});await refresh();});
refresh().catch(rejected);
setInterval(()=>{if(!document.hidden)tasks().catch(rejected);},10000);
</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}
