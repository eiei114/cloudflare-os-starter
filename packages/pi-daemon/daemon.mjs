import { mkdir, readFile, rename, open, unlink, realpath, stat, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { runPi } from './pi-process.mjs';

export function stateDirectory(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'CloudflareOSPiDaemon');
  return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'eisuke-os-pi-daemon')
    : path.join(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'eisuke-os-pi-daemon');
}
export async function protectDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const who = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    const sid = who.stdout?.match(/S-1-5-[0-9-]+/)?.[0];
    if (!sid || who.status !== 0) throw new Error('Cannot identify Windows user');
    const literal = `'${dir.replaceAll("'", "''")}'`;
    const script = `$ErrorActionPreference='Stop';$sid=New-Object System.Security.Principal.SecurityIdentifier('${sid}');
$acl=New-Object System.Security.AccessControl.DirectorySecurity;$acl.SetAccessRuleProtection($true,$false);$acl.SetOwner($sid);
$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
$acl.AddAccessRule($rule);Set-Acl -LiteralPath ${literal} -AclObject $acl;`;
    const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
    if (acl.status !== 0) throw new Error('Cannot protect Windows state directory');
  } else {
    const { chmod } = await import('node:fs/promises'); await chmod(dir, 0o700);
  }
}
export async function writePrivate(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(tmp, file);
}
export function validateConfig(c) {
  const u = new URL(c.url);
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('HTTPS OS origin required');
  if (!Array.isArray(c.projects) || !c.projects.length || c.projects.length > 20) throw new Error('Register trusted local projects first');
  const names = new Set();
  for (const p of c.projects) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(p.alias) || names.has(p.alias) || !path.isAbsolute(p.cwd) ||
        !Array.isArray(p.models) || !p.models.length || p.models.some(m => typeof m !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(m)))
      throw new Error('Invalid project alias, absolute cwd or model allowlist');
    names.add(p.alias);
  }
  return c;
}
export function client(config, credential, fetcher = fetch) {
  return async (op, body) => {
    const headers = { 'content-type': 'application/json' };
    if (credential?.token) headers.authorization = `Bearer ${credential.token}`;
    if (config.accessClientId && config.accessClientSecret) {
      headers['cf-access-client-id'] = config.accessClientId;
      headers['cf-access-client-secret'] = config.accessClientSecret;
    }
    const r = await fetcher(`${config.url.replace(/\/$/, '')}/gatekeeper/custom/runner/device/${op}`, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok || !r.headers.get('content-type')?.includes('application/json')) throw new Error('Daemon request rejected; check Access, pairing and lease');
    return r.json();
  };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Idle delay changes cloud traffic only. Local stop remains responsive without
// weakening the separate five-second heartbeat and lease timer during execution.
export async function waitForPoll(ms, dir, stopSignal, pause = sleep) {
  while (ms > 0) {
    if (stopSignal?.aborted || await access(path.join(dir, 'stop.request')).then(() => true, () => false)) return;
    const step = Math.min(ms, 1000);
    await pause(step); ms -= step;
  }
}

/** Single process/device. Exact durable report replay; never execution replay. */
export async function runDaemon(config, credential, dir, { execute = runPi, stopSignal, request = client(config, credential), pause = sleep } = {}) {
  validateConfig(config);
  for (const p of config.projects) {
    p.cwd = await realpath(p.cwd);
    if (!(await stat(p.cwd)).isDirectory()) throw new Error('Local project missing');
  }
  const localEnv = { ...process.env };
  if (config.cursorAuthFile && !localEnv.CURSOR_API_KEY) {
    if (!path.isAbsolute(config.cursorAuthFile)) throw new Error('Cursor fallback path must be absolute and trusted locally');
    const fallback = JSON.parse(await readFile(config.cursorAuthFile, 'utf8'));
    if (fallback.cursor?.type !== 'api_key' || typeof fallback.cursor.key !== 'string') throw new Error('Invalid local Cursor fallback');
    localEnv.CURSOR_API_KEY = fallback.cursor.key;
  }
  const lockFile = path.join(dir, 'daemon.lock');
  // Stale lock is NOT auto-cleared: receipt/process requires local inspection.
  const lock = await open(lockFile, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  const receiptFile = path.join(dir, 'receipt.json');
  let current;
  try {
    let recovered; try { recovered = JSON.parse(await readFile(receiptFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (recovered) {
      if (!recovered.report) throw new Error('Interrupted execution. Inspect local Pi process/session before re-pairing; never replay.');
      await request('finish', recovered.report); await unlink(receiptFile);
    }
    const catalog = await request('catalog', { projects: config.projects.map(({ alias, models }) => ({ alias, models })) });
    for (const p of catalog.projects) console.log(`Pi project: pi-project://projects/${p.id}`);
    let retryMs = 5000;
    while (true) {
      if (stopSignal?.aborted) break;
      if (await access(path.join(dir, 'stop.request')).then(() => true, () => false)) break;
      let task; const claimStarted = Date.now();
      try {
        // claim already updates lastSeen, so an additional idle heartbeat is redundant.
        ({ task } = await request('claim', { attempt: randomUUID() }));
        retryMs = 5000;
      } catch {
        await waitForPoll(retryMs, dir, stopSignal, pause);
        retryMs = Math.min(30_000, retryMs * 2);
        continue; // idle reconnect never executes or replays a job
      }
      if (!task) { await waitForPoll(30_000, dir, stopSignal, pause); continue; }
      const project = config.projects.find(p => p.alias === task.alias && p.models.includes(task.model));
      if (!project) throw new Error('Claimed project/model not allowed locally');
      const receipt = { id: task.id, attempt: task.attempt };
      await writePrivate(receiptFile, receipt); // BEFORE spawning Pi
      const controller = new AbortController(); current = controller;
      let progress = 'starting';
      const halt = () => controller.abort(); stopSignal?.addEventListener('abort', halt, { once: true });
      let timer = setTimeout(halt, Math.max(0, 35_000 - (Date.now() - claimStarted))); let running = true;
      if (stopSignal?.aborted) halt();
      const heartbeat = (async () => {
        while (true) {
          if (!running || controller.signal.aborted) break;
          if (await access(path.join(dir, 'stop.request')).then(() => true, () => false)) { halt(); break; }
          try {
            const renewalStarted = Date.now();
            const ack = await request('heartbeat', { ...receipt, progress });
            if (ack.cancel) halt();
            else { clearTimeout(timer); timer = setTimeout(halt, Math.max(0, 35_000 - (Date.now() - renewalStarted))); }
          } catch { /* Independent timer stops local execution before server lease expires. */ }
          await sleep(5000);
        }
      })();
      let outcome;
      try {
        const sessionDir = path.join(dir, 'sessions', task.id); await mkdir(sessionDir, { recursive: true, mode: 0o700 });
        outcome = await execute({ cwd: project.cwd, model: task.model, prompt: task.prompt, sessionDir,
          env: localEnv, signal: controller.signal, progress: value => { progress = value; } });
      } catch { outcome = { status: 'uncertain', result: 'Execution interrupted; inspect local session.' }; }
      finally { running = false; clearTimeout(timer); stopSignal?.removeEventListener('abort', halt); await heartbeat; current = undefined; }
      const report = { ...receipt, ...outcome };
      await writePrivate(receiptFile, { ...receipt, report });
      await request('finish', report); await unlink(receiptFile);
      if (outcome.status === 'uncertain') throw new Error('Uncertain execution: device quarantined; inspect locally before re-pairing');
    }
  } finally { current?.abort(); await unlink(lockFile); }
}

async function main() {
  const dir = stateDirectory(); await protectDirectory(dir);
  const configFile = path.join(dir, 'config.json');
  const command = process.argv[2];
  if (command === 'init') {
    const h = await open(configFile, 'wx', 0o600);
    await h.writeFile(JSON.stringify({ url: 'https://your-os.example.com', projects: [] }, null, 2)); await h.close();
    console.log(`Edit trusted project aliases, absolute paths and model allowlists: ${configFile}`); return;
  }
  const config = validateConfig(JSON.parse(await readFile(configFile, 'utf8')));
  const credentialFile = path.join(dir, 'credential.json');
  if (command === 'pair') {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = await rl.question('One-use pairing code (private terminal): '); rl.close();
    if (!/^[a-f0-9]{64}$/.test(code)) throw new Error('Invalid pairing code');
    const result = await client(config)('pair', { code });
    await writePrivate(credentialFile, result); console.log('Device paired.'); return;
  }
  if (command !== 'run') throw new Error('Usage: node daemon.mjs init|pair|run');
  const credential = JSON.parse(await readFile(credentialFile, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(credential.token)) throw new Error('Invalid credential');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  await runDaemon(config, credential, dir, { stopSignal: controller.signal });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Pi daemon stopped. Check private local config, Access, receipt and installation.'); process.exitCode = 1; });
}
