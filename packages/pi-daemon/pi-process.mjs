import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Dedicated RPC process; normal profile and trusted project, never cloud-supplied argv/env. */
export function runPi({ cwd, model, prompt, sessionDir, signal, progress = () => {},
  launch = spawn, cli = fileURLToPath(new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))),
  node = process.execPath, env = process.env, abortGraceMs = 5000, timeoutMs = 3600_000 }) {
  const slash = model.indexOf('/');
  if (slash < 1 || !cwd || !sessionDir) throw new Error('Invalid local Pi configuration');
  const child = launch(node, [cli, '--mode', 'rpc', '--provider', model.slice(0, slash),
    '--model', model.slice(slash + 1), '--session-dir', sessionDir], {
    cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
  });
  let stopped = false, settled = false, finished = false, lastReason, text = '', stoppingTimer;
  const pending = new Map(); let seq = 0;
  const lines = createInterface({ input: child.stdout });
  const send = (type, extra = {}) => {
    const id = `${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Pi command timed out')); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n', err => {
        if (err) { clearTimeout(timer); pending.delete(id); reject(new Error('Pi input closed')); }
      });
    });
  };
  const terminate = () => {
    if (process.platform === 'win32') {
      if (child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  };
  let finish;
  const result = new Promise(resolve => { finish = (status, resultText = '') => {
    if (finished) return; finished = true;
    clearTimeout(stoppingTimer); clearTimeout(runtimeTimer);
    signal?.removeEventListener('abort', stop); lines.close();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Pi ended')); }
    pending.clear(); terminate();
    resolve({ status, result: Buffer.from(resultText).subarray(0, 31_990).toString('utf8') });
  }; });
  const stop = () => {
    if (stopped || finished) return; stopped = true; progress('stopping');
    void send('abort').catch(() => {});
    stoppingTimer = setTimeout(() => finish('uncertain', 'Pi forcibly stopped; inspect local side effects.'), abortGraceMs);
  };
  const runtimeTimer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  child.on('error', () => finish('failed', 'Pi could not start. Check local installation.'));
  child.on('exit', () => { if (!finished) finish('uncertain', 'Pi exited before confirmed settlement.'); });
  lines.on('line', line => {
    // Never forward raw stdout, tool arguments, errors or private paths.
    if (line.length > 2_000_000) { stop(); return; }
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'response') {
      const p = pending.get(event.id); if (!p) return;
      clearTimeout(p.timer); pending.delete(event.id);
      if (event.success) p.resolve(event.data); else p.reject(new Error('Pi command rejected'));
    } else if (event.type === 'extension_ui_request') {
      if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
        child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true }) + '\n');
        stop();
      }
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      lastReason = event.message.stopReason;
      text = (event.message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('').slice(0, 64_000);
    } else if (event.type === 'tool_execution_start') progress('tool');
    else if (event.type === 'agent_start') progress('thinking');
    else if (event.type === 'agent_settled') {
      settled = true; progress('settled');
      if (stopped) finish('cancelled', 'Pi acknowledged stop. Earlier side effects remain.');
      else if (!['stop', 'length'].includes(lastReason)) finish('failed', 'Pi did not confirm a final answer; inspect local session.');
      else finish('completed', text);
    }
  });
  void (async () => {
    progress('starting');
    await send('set_model', { provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
    if (stopped || finished) return;
    await send('prompt', { message: prompt });
  })().catch(() => { if (!settled && !finished) finish('failed', 'Pi preflight rejected; check local model/auth/extensions.'); });
  if (signal?.aborted) stop();
  return result;
}
