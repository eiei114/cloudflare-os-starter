import { createRemoteJWKSet, jwtVerify } from 'jose';
import { digest, callCoordinator, type PiCoordinator } from './pi-coordinator.js';
import type { PiConsoleEnv } from './pi-console.js';
import { githubCatalog, repoName } from './github-projects.js';

export type DaemonEnv = PiConsoleEnv & {
  PI_DAEMON_ENABLED?: boolean;
  PI_DAEMON_ACCESS_AUD?: string;
  PI_DAEMON_SERVICE_ID?: string;
  PI_REQUEST_LIMITER?: RateLimit;
  PI_COORDINATOR?: DurableObjectNamespace<PiCoordinator>;
  WORKSHOP_BACKEND?: Fetcher;
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
    const deviceOps = ['pair', 'catalog', 'claim', 'heartbeat', 'finish', 'rotate'];
  const ownerOps = ['', 'pair-code', 'inventory', 'revoke', 'tasks', 'task', 'submit', 'cancel', 'review',
    'management', 'workspace-save', 'managed-project-save', 'agent-save', 'github-repos'];
  if (!(isDevice ? deviceOps : ownerOps).includes(op)) return json({ error: 'Not found' }, 404);
  if (req.method !== (op === '' ? 'GET' : 'POST')) return json({ error: 'Method not allowed' }, 405);
  let phase = 'authentication';
  try {
    let auth: { owner?: boolean; hash?: string } = {};
    let identity = 'local-test';
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
      identity = `owner:${payload.email}`;
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
        if (!env.PI_DAEMON_SERVICE_ID || payload.common_name !== env.PI_DAEMON_SERVICE_ID || payload.email !== undefined)
          return json({ error: 'Service identity required' }, 403);
        identity = `service:${payload.common_name}`;
      } else if (cookie) return json({ error: 'Browser cookies forbidden' }, 403);
      if (op !== 'pair') {
        const token = req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token) return json({ error: 'Device authentication required' }, 401);
        auth.hash = await digest(token);
      }
    }
    // Production Access configuration must have a limiter. Never silently fail open.
    if (!env.PI_REQUEST_LIMITER && env.PI_DAEMON_ACCESS_AUD) return json({ error: 'Rate limiter unavailable' }, 503);
    if (env.PI_REQUEST_LIMITER && !(await env.PI_REQUEST_LIMITER.limit({ key: identity })).success)
      return json({ error: 'Request limit exceeded' }, 429);
    if (op === '') return portal();
    phase = 'body';
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
    phase = 'coordinator';
    if (op === 'github-repos') return json(await githubCatalog(req, env, data));
    if (op === 'managed-project-save' && data.github) {
      const link = data.github;
      const name = repoName(link.fullName);
      if (!Number.isSafeInteger(link.accountId) || link.accountId <= 0) return json({ error: 'Invalid GitHub account' }, 400);
      const catalog = await githubCatalog(req, env, { accountId: link.accountId, query: name });
      const repo = catalog.repos.find(r => r.value.toLowerCase() === name.toLowerCase());
      if (!repo) return json({ error: 'Repository unavailable in connected account' }, 400);
      data.github = { accountId: link.accountId, fullName: repo.value, verifiedAt: Date.now() };
    }
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
    if (op === 'rotate') {
      if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) return json({ error: 'Invalid rotation' }, 400);
      return json(await callCoordinator(env, 'rotate', { tokenHash: await digest(data.token) }, auth));
    }
    if (op === 'submit') {
      // Human-only approval surface, not an agent API or device capability.
      // Ignore caller-supplied source/auth fields. Agent submissions still use ApprovalQueue.
      if (data.approved !== true) return json({ error: 'Explicit owner approval required' }, 400);
      const task = await callCoordinator(env, 'enqueue', { id: data.id, projectId: data.projectId,
        prompt: data.prompt, model: data.model, title: data.title, managedProjectId: data.managedProjectId,
        agentId: data.agentId, agentRevision: data.agentRevision, source: 'owner-ui' }, auth);
      return json({ id: task.id, projectId: task.projectId, status: task.status });
    }
    // Never let request data select owner authority or change its token identity.
    return json(await callCoordinator(env, op, data, auth));
  } catch (error) {
    // Do not expose prompts, tokens, provider errors or private stack traces.
    if (!isDevice) console.warn('Pi owner request rejected', { op, phase,
      category: error instanceof TypeError ? 'type' : error instanceof SyntaxError ? 'syntax' :
        error instanceof Error && error.message.includes('Operation denied') ? 'operation' : 'validation' });
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
</style><style nonce="${nonce}">
body{padding:0;max-width:none}.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh}.sidebar{background:#151b28;color:#dae1ee;padding:1.4rem;position:sticky;top:0;height:100vh}.brand{font-weight:750;font-size:1.15rem;color:white;margin-bottom:1.5rem}.sidebar label{font-size:.8rem;color:#adb9cc}.sidebar select{width:100%;background:#242d3e;color:white;border-color:#3b475d}.sidebar nav{display:grid;gap:.4rem;margin-top:1.8rem}.sidebar nav a{color:#c8d2e3;text-decoration:none;padding:.65rem .8rem;border-radius:7px}.sidebar nav a[aria-current="page"]{background:#2e3a50;color:white}.sidebar footer{margin-top:2rem;font-size:.8rem;color:#adb9cc}.main{padding:2rem;min-width:0}.panel[hidden]{display:none}.page-title{font-size:1.8rem;margin-bottom:.5rem}.grid-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:1rem;margin:1.2rem 0}.setting-form{background:white;border:1px solid #dce2eb;padding:1.3rem;border-radius:10px;max-width:850px}.setting-form input:not([type="checkbox"]),.setting-form select{width:100%}.setting-form textarea{min-height:5rem}.setting-actions{display:flex;gap:.5rem;margin-top:1rem}.filter{max-width:340px}.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:1rem}.stat{background:white;border:1px solid #dce2eb;border-radius:10px;padding:1rem}.stat strong{display:block;font-size:1.7rem}dl{font-size:.85rem}dt{color:#526074}dd{margin:0 0 .5rem;overflow-wrap:anywhere}.board{min-width:1240px}header{margin-bottom:1.5rem}@media(max-width:850px){.shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;padding:1rem}.sidebar nav{display:flex;flex-wrap:wrap;margin-top:1rem}.sidebar footer{display:none}.sidebar select{max-width:320px}.brand{margin-bottom:.5rem}.main{padding:1rem}.summary-grid{grid-template-columns:repeat(2,1fr)}}
</style>
<div class="shell"><aside class="sidebar"><div class="brand">Cloudflare OS</div>
<label>ワークスペース <select id="workspace"></select></label>
<nav aria-label="ワークスペースのページ"><a href="#overview">概要</a><a href="#tasks">タスクボード</a><a href="#projects">プロジェクト</a><a href="#agents">エージェント</a><a href="#runtimes">ランタイム</a><a href="#settings">ワークスペース設定</a></nav>
<footer>Private workspace<br>所有者専用 · ローカルPi実行<br><a href="/">OSホームへ</a></footer></aside><main class="main">
<header><h1>Cloudflare OS <span id="page-label" class="hint">/ タスクボード</span></h1>
<p>ここでタスクを作成・承認・確認。登録端末のPiが裏で実行します。<a href="/">OSホーム</a></p></header>
<p id="message" role="status"></p>
<section class="panel" id="page-overview" hidden><h2 class="page-title">ワークスペースの概要</h2><p id="workspace-name"></p><div class="summary-grid" id="summary"></div><p class="hint">プロジェクトで仕事を分類し、エージェントにランタイム・モデル・役割を設定します。タスクの実行は明示的な承認が必要です。</p></section>
<section class="panel" id="page-tasks">
<details class="compose" open><summary>新しいタスク</summary><section aria-labelledby="create-title"><h2 id="create-title">タスクを作成</h2>
<label>タイトル <input id="title" maxlength="100" placeholder="例：ログイン画面の表示を直す"></label>
<div class="fields"><label>実行先プロジェクト <select id="project"></select></label>
<label>担当エージェント <select id="agent"></select></label></div>
<label>モデル <select id="model"></select></label>
<label>指示 <textarea id="prompt" maxlength="32000" placeholder="何をしてほしいか、完了条件を書いてください"></textarea></label>
<p class="hint">Piは端末の通常の設定・認証・拡張・ファイル操作権限を使います。サンドボックスではありません。指示と最終回答はCloudflareに保存され、モデルの利用料金が発生する場合があります。</p>
<button class="primary" id="submit">承認して実行待ちに追加</button></section></details>
<section aria-labelledby="tasks-title"><div class="toolbar"><h2 id="tasks-title">タスク</h2><button id="tasks-refresh">ボードを更新</button></div>
<label class="filter">プロジェクトで絞り込み <select id="task-filter"></select></label>
<p class="hint">画面は待機中30秒、タスク実行待ち・実行中は5秒ごとに更新。端末の取得待ちは最大約30秒。端末は起動・接続が必要です。現在の保存上限は100件。結果が不確定なタスクは自動再実行せず、端末側で確認してください。取消は実行済みの変更を元に戻しません。既存Multicaのタスクは別管理です。</p>
<div class="board-scroll" tabindex="0" aria-label="タスクボード。横スクロールできます"><div class="board" id="tasks"></div></div>
<h3 id="result-title">カードを選んで結果を確認</h3><pre id="result" aria-live="polite"></pre></section></section>
<section class="panel" id="page-projects" hidden><h2 class="page-title">プロジェクト</h2><p class="hint">名前・説明・属性で仕事を分類。実行先は端末が事前登録したフォルダだけを選べます。ここから任意のパスやGitHub repoを端末へ追加できません。</p><button id="project-new">プロジェクトを追加</button><div id="project-list" class="grid-list"></div>
<section class="setting-form" aria-labelledby="project-edit-title"><h3 id="project-edit-title">プロジェクト設定</h3><input id="project-id" type="hidden"><label>プロジェクト名 <input id="project-name" maxlength="100"></label><label>説明 <textarea id="project-description" maxlength="1000"></textarea></label>
<h4>GitHubリポジトリ</h4><p class="hint">OSに接続済みのGitHubアカウントから選びます。公開・非公開repoの一覧だけを読み、追加ではclone・書き込み・OS Agentへの権限付与を行いません。</p><button id="github-load">接続済みGitHubからリポジトリを取得</button><label>GitHubアカウント <select id="github-account"></select></label><div class="fields"><label>リポジトリ検索 <input id="github-query" maxlength="200" placeholder="名前 または owner/repo"></label><div><button id="github-search">検索</button></div></div><label>アクセス可能なリポジトリ <select id="github-repo"></select></label><button id="github-select">選択したrepoを紐づけ</button><button id="github-clear">紐づけを外す</button><p id="github-selected" role="status">リポジトリ未設定</p><p class="hint">GitHubが見つからない場合は <a href="/gatekeepers" target="_blank" rel="noopener noreferrer">OSの接続設定</a> を確認してください。初期一覧は更新順100件。検索で対象を絞れます。</p>
<label>登録済み実行先 <select id="execution-project"></select></label><label>属性（JSON・文字列の組） <textarea id="project-attributes" spellcheck="false" placeholder='{"category":"development","priority":"normal"}'>{}</textarea></label><p class="hint">実行先未設定でもrepoを管理できます。実行には端末側のフォルダ登録が必要です。最大10属性。実行先変更は今後のタスクだけに適用されます。</p><button id="project-save" class="primary">プロジェクトを保存</button></section></section>
<section class="panel" id="page-agents" hidden><h2 class="page-title">エージェント</h2><p class="hint">実行する端末・モデル・役割を設定します。認証情報は端末に置いたまま。Piの通常の認証・設定・拡張を読みます。</p><button id="agent-new">エージェントを追加</button><div id="agent-list" class="grid-list"></div>
<section class="setting-form" aria-labelledby="agent-edit-title"><h3 id="agent-edit-title">エージェント設定</h3><input id="agent-id" type="hidden"><label>名前 <input id="agent-name" maxlength="100"></label><div class="fields"><label>ランタイム <select id="agent-runtime"></select></label><label>モデル <select id="agent-model"></select></label></div><p>実行エンジン：Pi Coding Agent / プロファイル：端末の通常設定</p><label>役割・追加指示 <textarea id="agent-instructions" maxlength="4000" placeholder="例：回答は日本語。変更前に既存のテストを確認する。"></textarea></label><label><input type="checkbox" id="agent-enabled" checked> 新しいタスクに割り当て可能</label><p class="hint">設定はタスク承認時に固定されます。編集しても実行中・実行待ちの仕事は変わりません。任意の環境変数・起動引数・拡張の遠隔インストールは扱いません。</p><button id="agent-save" class="primary">エージェントを保存</button></section></section>
<section class="panel" id="page-runtimes" hidden><h2 class="page-title">ランタイム</h2><p class="hint">登録端末の状態。ランタイムはワークスペース間で共有する実行資源です。認証・権限境界としてワークスペースを使わないでください。</p><div id="runtime-list" class="grid-list"></div>
<details class="devices"><summary>実行端末と接続設定</summary><h2>端末の登録 — 所有者専用</h2>
<p class="hint">端末ごとに一度だけ登録します。モデルのAPIキーはここへ入力しないでください。</p>
<label>端末名 <input id="label" maxlength="80"></label>
<label>OS <select id="platform"><option>darwin</option><option>win32</option></select></label>
<button id="pair">5分間有効な登録コードを作成</button><button id="copy-code">登録コードをコピー</button><pre id="code"></pre>
<button id="refresh">端末とプロジェクトを更新</button><pre id="inventory"></pre>
<label>登録を解除する端末ID <input id="device"></label><button id="revoke">端末登録を解除</button></details></section>
<section class="panel" id="page-settings" hidden><h2 class="page-title">ワークスペース設定</h2><section class="setting-form"><label>ワークスペース名 <input id="workspace-edit-name" maxlength="100"></label><button id="workspace-save">名前を保存</button><hr><label>新しいワークスペース名 <input id="workspace-new-name" maxlength="100"></label><button id="workspace-create">ワークスペースを作成</button><p class="hint">単一所有者の分類用です。メンバー招待・テナント分離・削除・移動は未対応。</p></section></section></main></div>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);
let projects=[],devices=[],management={workspaces:[],projects:[],agents:[]},submissionId=null,snapshot='',selectedTask=null,taskCache=[],projectGithub=null,githubOptions=[],currentPage='tasks',ready=false,polling=false,nextPollAt=0;
const workspaceId=()=>el('workspace').value;
const visibleProjects=()=>management.projects.filter(p=>p.workspaceId===workspaceId());
const execution=p=>projects.find(e=>e.id===p?.executionProjectId);
const projectName=t=>management.projects.find(p=>p.id===(t.managedProjectId||t.projectId))?.name||projects.find(p=>p.id===t.projectId)?.alias||t.projectId;
async function call(op,data){const r=await fetch('./'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw Error('Request rejected');return v;}
function option(select,value,label){const o=document.createElement('option');o.value=value;o.textContent=label;select.append(o);}
function models(reset=true){const selected=el('model').value;el('model').replaceChildren();const p=execution(visibleProjects().find(p=>p.id===el('project').value));const a=management.agents.find(a=>a.id===el('agent').value);for(const m of p?.models||[])if(!a||a.model===m)option(el('model'),m,m);el('model').disabled=!!a;if(!reset&&[...el('model').options].some(o=>o.value===selected))el('model').value=selected;if(reset)submissionId=null;}
function agents(reset=true){const selected=el('agent').value;el('agent').replaceChildren();option(el('agent'),'','直接Piを実行（担当なし）');const p=execution(visibleProjects().find(p=>p.id===el('project').value));for(const a of management.agents)if(a.workspaceId===workspaceId()&&a.enabled&&a.deviceId===p?.deviceId&&p.models.includes(a.model))option(el('agent'),a.id,a.name+' — '+a.model);if([...el('agent').options].some(o=>o.value===selected))el('agent').value=selected;models(reset);}
function selections(){const selected=el('project').value,filter=el('task-filter').value;el('project').replaceChildren();el('task-filter').replaceChildren();option(el('task-filter'),'','すべてのプロジェクト');for(const p of visibleProjects()){option(el('task-filter'),p.id,p.name);if(execution(p))option(el('project'),p.id,p.name+' — '+devices.find(d=>d.id===execution(p).deviceId)?.label);}if([...el('project').options].some(o=>o.value===selected))el('project').value=selected;if([...el('task-filter').options].some(o=>o.value===filter))el('task-filter').value=filter;agents(false);}
async function refresh(){const [v,m]=await Promise.all([call('inventory',{}),call('management',{})]);devices=v.devices;projects=v.projects.filter(p=>devices.some(d=>d.id===p.deviceId&&!d.revoked));management=m;el('inventory').textContent=JSON.stringify({devices:v.devices,projects:v.projects.map(p=>({...p,url:'pi-project://projects/'+p.id}))},null,2);const selected=workspaceId();el('workspace').replaceChildren();for(const w of m.workspaces)option(el('workspace'),w.id,w.name);if(m.workspaces.some(w=>w.id===selected))el('workspace').value=selected;selections();renderManagement();snapshot='';await tasks();ready=true;nextPollAt=Date.now()+pollDelay(currentPage,taskCache);}
const columns=[['queued','実行待ち'],['running','実行中'],['review','確認待ち'],['done','完了'],['attention','停止・要対応']];
const statuses={queued:'実行待ち',running:'実行中','cancel-requested':'取消依頼中',completed:'実行完了',failed:'失敗',cancelled:'取消済み',uncertain:'結果不確定'};
const stages={starting:'起動中',thinking:'応答生成中',tool:'ツール実行中',settled:'応答確定',stopping:'停止中'};
const column=t=>t.status==='completed'?(t.reviewedAt?'done':'review'):['running','cancel-requested'].includes(t.status)?'running':t.status==='queued'?'queued':'attention';
const taskTitle=t=>t.title||'タスク '+t.id.slice(0,8);
function node(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function action(parent,label,t,fn){const b=node('button',label);b.setAttribute('aria-label',taskTitle(t)+'：'+label);b.onclick=()=>fn().catch(rejected);parent.append(b);}
async function tasks(){const v=await call('tasks',{});const selectedBefore=taskCache.find(t=>t.id===selectedTask?.id);taskCache=v.tasks;nextPollAt=0;const next=JSON.stringify([workspaceId(),el('task-filter').value,v.tasks]);if(next===snapshot)return;snapshot=next;el('tasks').replaceChildren();const list=v.tasks.filter(t=>(t.workspaceId||'personal')===workspaceId()&&(!el('task-filter').value||(t.managedProjectId||t.projectId)===el('task-filter').value));renderSummary();
for(const [key,label] of columns){const section=node('section',undefined,'column');section.dataset.column=key;section.setAttribute('aria-label',label);const items=list.filter(t=>column(t)===key);const heading=node('h3',label);heading.append(node('span',String(items.length),'count'));section.append(heading);
for(const t of items){const card=node('article',undefined,'card');card.dataset.taskId=t.id;card.setAttribute('aria-label',taskTitle(t));card.append(node('h4',taskTitle(t)));card.append(node('p',projectName(t),'meta'));card.append(node('p',(statuses[t.status]||t.status)+(t.progress&&['running','cancel-requested'].includes(t.status)?' · '+(stages[t.progress]||t.progress):''),'badge'));card.append(node('p',t.agentName||'直接Piを実行','meta'));card.append(node('p',t.model,'meta'));card.append(node('p',t.source==='owner-ui'?'手動承認':'OS Agent承認','meta'));card.append(node('p',t.id,'task-id'));const buttons=node('div',undefined,'actions');action(buttons,'結果を見る',t,()=>view(t));
if(['queued','running','cancel-requested'].includes(t.status))action(buttons,'取消を依頼',t,async()=>{if(!confirm(taskTitle(t)+'を取り消しますか？ 実行済みの変更は元に戻りません。'))return;await call('cancel',{id:t.id,projectId:t.projectId});await tasks();await view(t);});
if(t.status==='completed'&&!t.reviewedAt)action(buttons,'確認して完了',t,async()=>{await view(t);if(!confirm(taskTitle(t)+'の結果を確認済みとして完了に移しますか？'))return;await call('review',{id:t.id,projectId:t.projectId});await tasks();});
card.append(buttons);section.append(card);}if(!items.length)section.append(node('p','タスクはありません','empty'));el('tasks').append(section);}
if(selectedTask&&JSON.stringify(selectedBefore)!==JSON.stringify(taskCache.find(t=>t.id===selectedTask.id)))await view(selectedTask);}
async function view(t){selectedTask=t;const v=await call('task',{id:t.id,projectId:t.projectId});el('result-title').textContent=taskTitle(t)+' — '+(statuses[v?.status]||'結果を取得できません');el('result').textContent=JSON.stringify(v,null,2);}
function rejected(){el('message').textContent='処理が拒否されました。状態を更新してから確認してください。';}
function on(id,fn){el(id).onclick=()=>fn().catch(rejected);}
function navigate(){const key=location.hash.slice(1)||'tasks';const labels={overview:'概要',tasks:'タスクボード',projects:'プロジェクト',agents:'エージェント',runtimes:'ランタイム',settings:'ワークスペース設定'};const page=Object.hasOwn(labels,key)?key:'tasks';currentPage=page;nextPollAt=0;for(const panel of document.querySelectorAll('.panel'))panel.hidden=panel.id!=='page-'+page;for(const link of document.querySelectorAll('.sidebar nav a')){if(link.hash==='#'+page)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}el('page-label').textContent='/ '+labels[page];document.title=labels[page]+' — Cloudflare OS';el('result').textContent='';selectedTask=null;if(ready)pollOwner(true).catch(rejected);}
function pollDelay(page,tasks){return page!=='runtimes'&&tasks.some(t=>['queued','running','cancel-requested'].includes(t.status))?5000:30000;}
async function pollOwner(force=false){if(!ready||document.hidden||polling||!['overview','tasks','runtimes'].includes(currentPage))return;if(!force&&Date.now()<nextPollAt)return;polling=true;const page=currentPage;let delay=30000;try{if(page==='runtimes'){const v=await call('inventory',{});devices=v.devices;renderRuntimes();}else await tasks();delay=pollDelay(page,taskCache.filter(t=>(t.workspaceId||'personal')===workspaceId()));}finally{nextPollAt=currentPage===page?Date.now()+delay:0;polling=false;}}
window.addEventListener('hashchange',navigate);navigate();
function renderSummary(){el('summary').replaceChildren();for(const [label,count] of [['プロジェクト',visibleProjects().length],['エージェント',management.agents.filter(a=>a.workspaceId===workspaceId()).length],['実行中',taskCache.filter(t=>(t.workspaceId||'personal')===workspaceId()&&['running','cancel-requested'].includes(t.status)).length],['確認待ち',taskCache.filter(t=>(t.workspaceId||'personal')===workspaceId()&&column(t)==='review').length]]){const box=node('div',label,'stat');box.append(node('strong',String(count)));el('summary').append(box);}}
function settingCard(list,title,description,edit){const card=node('article',undefined,'card');card.append(node('h3',title),node('p',description,'meta'));if(edit){const b=node('button','設定を編集');b.setAttribute('aria-label',title+'：設定を編集');b.onclick=edit;card.append(b);}list.append(card);return card;}
function runtimeStatus(d){return d.revoked?'登録解除済み':Date.now()-d.seen<45000?'オンライン':'オフライン';}
function renderRuntimes(){el('runtime-list').replaceChildren();for(const d of devices){const card=settingCard(el('runtime-list'),d.label,d.platform+' · '+runtimeStatus(d));const dl=node('dl');dl.append(node('dt','ランタイムID'),node('dd',d.id),node('dt','登録済み実行先'),node('dd',projects.filter(p=>p.deviceId===d.id).map(p=>p.alias).join(', ')||'なし'));card.append(dl);}}
function runtimeModels(){const selected=el('agent-model').value;el('agent-model').replaceChildren();const allowed=[...new Set(projects.filter(p=>p.deviceId===el('agent-runtime').value).flatMap(p=>p.models))];for(const m of allowed)option(el('agent-model'),m,m);if(allowed.includes(selected))el('agent-model').value=selected;}
function showGithub(){el('github-selected').textContent=projectGithub?'紐づけ：'+projectGithub.fullName+' / GitHub account '+projectGithub.accountId:'リポジトリ未設定';}
function editProject(p){el('project-id').value=p?.id||'';el('project-name').value=p?.name||'';el('project-description').value=p?.description||'';el('project-attributes').value=JSON.stringify(p?.attributes||{},null,2);el('execution-project').value=p?.executionProjectId||'';projectGithub=p?.github||null;showGithub();el('project-name').focus();}
function editAgent(a){el('agent-id').value=a?.id||'';el('agent-name').value=a?.name||'';el('agent-instructions').value=a?.instructions||'';el('agent-enabled').checked=a?.enabled??true;if(a)el('agent-runtime').value=a.deviceId;runtimeModels();if(a)el('agent-model').value=a.model;el('agent-name').focus();}
function renderManagement(){const w=management.workspaces.find(w=>w.id===workspaceId());el('workspace-name').textContent=w?.name||'';el('workspace-edit-name').value=w?.name||'';el('project-list').replaceChildren();for(const p of visibleProjects()){const card=settingCard(el('project-list'),p.name,p.description||'説明なし',()=>editProject(p));card.append(node('p','実行先：'+(execution(p)?.alias||'未設定・利用不可'),'meta'));if(p.github){const a=node('a',p.github.fullName);a.href='https://github.com/'+p.github.fullName;a.target='_blank';a.rel='noopener noreferrer';card.append(a);}const dl=node('dl');for(const [k,v] of Object.entries(p.attributes))dl.append(node('dt',k),node('dd',v));card.append(dl);const b=node('button','このプロジェクトのタスク');b.onclick=()=>{el('task-filter').value=p.id;location.hash='tasks';snapshot='';tasks().catch(rejected);};card.append(b);}
el('agent-list').replaceChildren();for(const a of management.agents.filter(a=>a.workspaceId===workspaceId())){const card=settingCard(el('agent-list'),a.name,(a.enabled?'有効':'無効')+' · Pi / 通常設定',()=>editAgent(a));card.append(node('p',devices.find(d=>d.id===a.deviceId)?.label||'利用不可','meta'),node('p',a.model,'meta'),node('p',a.instructions||'追加指示なし','meta'));}
const target=el('execution-project').value;el('execution-project').replaceChildren();option(el('execution-project'),'','未設定（リポジトリ管理のみ）');for(const p of projects)option(el('execution-project'),p.id,p.alias+' — '+devices.find(d=>d.id===p.deviceId)?.label);if(projects.some(p=>p.id===target))el('execution-project').value=target;
const runtime=el('agent-runtime').value;el('agent-runtime').replaceChildren();for(const d of devices.filter(d=>!d.revoked))option(el('agent-runtime'),d.id,d.label+' — '+runtimeStatus(d));if(devices.some(d=>d.id===runtime&&!d.revoked))el('agent-runtime').value=runtime;runtimeModels();renderRuntimes();renderSummary();}
el('workspace').onchange=()=>{submissionId=null;el('project-id').value='';el('agent-id').value='';el('project-name').value='';el('agent-name').value='';el('project-description').value='';el('project-attributes').value='{}';el('agent-instructions').value='';el('prompt').value='';el('title').value='';projectGithub=null;showGithub();el('execution-project').value='';selectedTask=null;el('result').textContent='';selections();renderManagement();snapshot='';tasks().catch(rejected);};
el('task-filter').onchange=()=>{snapshot='';tasks().catch(rejected);};
el('agent-runtime').onchange=runtimeModels;
on('project-new',async()=>editProject());on('agent-new',async()=>editAgent());
on('workspace-save',async()=>{await call('workspace-save',{id:workspaceId(),name:el('workspace-edit-name').value.trim()});await refresh();el('message').textContent='ワークスペース名を保存しました。';});
on('workspace-create',async()=>{const id=crypto.randomUUID();await call('workspace-save',{id,name:el('workspace-new-name').value.trim()});await refresh();el('workspace').value=id;el('workspace').onchange();el('workspace-new-name').value='';el('message').textContent='ワークスペースを作成しました。';});
async function loadGithub(){for(const id of ['github-load','github-search','github-select','project-save'])el(id).disabled=true;try{const selected=Number(el('github-account').value)||undefined;const v=await call('github-repos',{accountId:selected,query:el('github-query').value});el('github-account').replaceChildren();if(v.accounts.length>1)option(el('github-account'),'','アカウントを選択してください');for(const a of v.accounts)option(el('github-account'),String(a.id),a.label);if(v.accounts.some(a=>a.id===selected))el('github-account').value=String(selected);githubOptions=v.repos;el('github-repo').replaceChildren();for(const r of v.repos)option(el('github-repo'),r.value,r.title+' · '+(r.meta||''));el('message').textContent=!v.accounts.length?'接続済みの有効なGitHubアカウントがありません。OSの接続設定を確認してください。':v.repos.length+'件のリポジトリを取得しました。';}finally{for(const id of ['github-load','github-search','github-select','project-save'])el(id).disabled=false;}}
on('github-load',loadGithub);on('github-search',loadGithub);el('github-account').onchange=()=>loadGithub().catch(rejected);
on('github-select',async()=>{const r=githubOptions.find(r=>r.value===el('github-repo').value),accountId=Number(el('github-account').value);if(!r||!accountId)return;projectGithub={accountId,fullName:r.value};if(!el('project-name').value.trim())el('project-name').value=r.value.split('/')[1];if(!el('project-description').value.trim())el('project-description').value=r.subtitle||'';showGithub();});
on('github-clear',async()=>{projectGithub=null;showGithub();});
on('project-save',async()=>{const id=el('project-id').value||crypto.randomUUID();el('project-id').value=id;el('project-save').disabled=true;try{await call('managed-project-save',{id,workspaceId:workspaceId(),name:el('project-name').value.trim(),description:el('project-description').value,executionProjectId:el('execution-project').value||undefined,attributes:JSON.parse(el('project-attributes').value),github:projectGithub||undefined});await refresh();el('message').textContent='プロジェクトを保存しました。';}finally{el('project-save').disabled=false;}});
on('agent-save',async()=>{const id=el('agent-id').value||crypto.randomUUID();el('agent-id').value=id;await call('agent-save',{id,workspaceId:workspaceId(),name:el('agent-name').value.trim(),deviceId:el('agent-runtime').value,model:el('agent-model').value,instructions:el('agent-instructions').value,enabled:el('agent-enabled').checked,harness:'pi',profile:'local'});await refresh();el('message').textContent='エージェントを保存しました。';});
el('project').onchange=()=>agents();el('agent').onchange=()=>models();el('title').oninput=el('model').onchange=el('prompt').oninput=()=>submissionId=null;
on('submit',async()=>{const managedProjectId=el('project').value,projectId=execution(visibleProjects().find(p=>p.id===managedProjectId))?.id,agentId=el('agent').value||undefined,model=el('model').value,prompt=el('prompt').value,title=el('title').value.trim()||undefined;
if(!projectId||!model||!prompt.trim())return el('message').textContent='プロジェクトとモデルを選び、指示を入力してください。';
if(new TextEncoder().encode(prompt).length>32000||title&&new TextEncoder().encode(title).length>200)return el('message').textContent='指示は32,000 UTF-8 bytes、タイトルは200 bytes以内にしてください。';
const a=management.agents.find(a=>a.id===agentId);if(!confirm(el('project').selectedOptions[0].textContent+'で '+model+'を使って実行しますか？ 担当：'+(a?.name||'直接Pi')+'。追加指示：'+(a?.instructions||'なし')+'。Piにはファイル変更・外部サービスの操作権限があります。'))return;
submissionId??=crypto.randomUUID();for(const id of ['submit','title','project','agent','model','prompt','refresh','workspace'])el(id).disabled=true;try{const t=await call('submit',{id:submissionId,projectId,managedProjectId,agentId,agentRevision:a?.revision,model,prompt,title,approved:true});submissionId=null;el('prompt').value='';el('title').value='';el('message').textContent='タスク '+t.id+'を実行待ちに追加しました。';await tasks();}finally{for(const id of ['submit','title','project','agent','model','prompt','refresh','workspace'])el(id).disabled=false;models(false);}});
on('tasks-refresh',tasks);
on('pair',async()=>{const v=await call('pair-code',{label:el('label').value,platform:el('platform').value});el('code').textContent=v.code;el('message').textContent='登録コードを作成しました。秘密のまま端末へ入力してください。';setTimeout(()=>el('code').textContent='',300000);});
on('copy-code',async()=>{if(!el('code').textContent)return;await navigator.clipboard.writeText(el('code').textContent);el('message').textContent='登録コードをコピーしました。使用後はクリップボードを消してください。';});
on('refresh',refresh);on('revoke',async()=>{if(!confirm('端末登録を解除しますか？ 実行中のタスクは不確定となり、端末側の確認が必要です。'))return;await call('revoke',{deviceId:el('device').value});await refresh();});
refresh().catch(rejected);
setInterval(()=>pollOwner().catch(rejected),5000);
document.addEventListener('visibilitychange',()=>{nextPollAt=0;pollOwner(true).catch(rejected);});
</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}
