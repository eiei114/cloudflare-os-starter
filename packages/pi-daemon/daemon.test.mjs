import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { stateDirectory, validateConfig, client, writePrivate, runDaemon, waitForPoll } from './daemon.mjs';
import { macPlist, windowsInstall } from './install.mjs';
import { runPi } from './pi-process.mjs';
import { fileURLToPath } from 'node:url';

test('macOS/Windows native paths and unprivileged startup quoting', () => {
  assert.equal(stateDirectory('win32', { LOCALAPPDATA: 'C:\\Users\\A B\\AppData\\Local' }), 'C:\\Users\\A B\\AppData\\Local\\CloudflareOSPiDaemon');
  assert.match(stateDirectory('darwin', {}, '/Users/A B'), /Application Support/);
  assert.match(macPlist('/node', '/a&b/daemon.mjs', '/state'), /a&amp;b/);
  const plist = macPlist('/node', '/daemon.mjs', '/state', '/opt/tools&bin:/usr/bin');
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/tools&amp;bin:\/usr\/bin<\/string>/);
  assert.doesNotMatch(plist, /CURSOR_API_KEY|accessClientSecret/);
  const ps = windowsInstall('C:\\Program Files\\node.exe', "C:\\Users\\O'Neil\\daemon.mjs");
  assert.match(ps, /Interactive -RunLevel Limited/); assert.match(ps, /O''Neil/);
  assert.doesNotMatch(ps, /SYSTEM|Highest|CURSOR_API_KEY/);
});
test('config forbids arbitrary origin, relative path, duplicate alias and wildcard model', () => {
  const base = { url: 'https://os.example.com', projects: [{ alias: 'repo', cwd: '/trusted', models: ['cursor/model'] }] };
  assert.equal(validateConfig(base), base);
  for (const url of ['http://os.example.com', 'https://user:pass@os.example.com', 'https://os.example.com/path']) assert.throws(() => validateConfig({ ...base, url }));
  assert.throws(() => validateConfig({ ...base, projects: [base.projects[0], base.projects[0]] }));
  assert.throws(() => validateConfig({ ...base, projects: [{ ...base.projects[0], cwd: 'relative' }] }));
});
test('device requests use bearer, optional Access service credentials, no cookies or redirect following', async () => {
  const request = client({ url: 'https://os.example.com', accessClientId: 'local-id', accessClientSecret: 'local-secret' }, { token: 'device-token' }, async (url, init) => {
    assert.equal(url, 'https://os.example.com/gatekeeper/custom/runner/device/heartbeat');
    assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, 'Bearer device-token');
    assert.equal(init.headers['cf-access-client-secret'], 'local-secret'); assert.equal(init.headers.cookie, undefined);
    return Response.json({});
  });
  await request('heartbeat', {});
});
test('idle daemon claims once per thirty seconds without redundant heartbeat', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-daemon-test-'));
  const controller = new AbortController(), requests = [], sleeps = [];
  try {
    await runDaemon({ url: 'https://os.example.com', projects: [{ alias: 'test', cwd: dir, models: ['cursor/model'] }] }, {}, dir, {
      stopSignal: controller.signal, request: async op => {
        requests.push(op); return op === 'catalog' ? { projects: [] } : { task: null };
      }, pause: async ms => { sleeps.push(ms); if (sleeps.length === 30) controller.abort(); },
      execute: () => { throw Error('must not execute idle'); },
    });
    assert.deepEqual(requests, ['catalog', 'claim']);
    assert.equal(sleeps.reduce((a, b) => a + b, 0), 30_000);
    assert.equal(sleeps.every(ms => ms === 1000), true);
    await assert.rejects(access(path.join(dir, 'daemon.lock')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('local stop interrupts idle polling within one second', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-daemon-test-')); const sleeps = [];
  try {
    await waitForPoll(30_000, dir, undefined, async ms => {
      sleeps.push(ms); await writePrivate(path.join(dir, 'stop.request'), {});
    });
    assert.deepEqual(sleeps, [1000]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('idle network failure backs off from five to thirty seconds, never executes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-daemon-test-'));
  const controller = new AbortController(), waits = []; let waited = 0;
  try {
    await runDaemon({ url: 'https://os.example.com', projects: [{ alias: 'test', cwd: dir, models: ['cursor/model'] }] }, {}, dir, {
      stopSignal: controller.signal, request: async op => {
        if (op === 'catalog') return { projects: [] };
        assert.equal(op, 'claim'); waits.push(waited); throw Error('unavailable');
      }, pause: async ms => { waited += ms; if (waited === 65_000) controller.abort(); },
      execute: () => { throw Error('must not execute offline'); },
    });
    assert.deepEqual(waits, [0, 5000, 15_000, 35_000]);
    assert.equal(waited, 65_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
function fakePi(handler) {
  return (_exe, args, opts) => {
    assert.equal(opts.shell, false); assert.equal(args.includes('--mode'), true);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => {};
    child.stdin = new Writable({ write(chunk, _enc, cb) {
      const cmd = JSON.parse(chunk.toString());
      queueMicrotask(() => handler(cmd, event => child.stdout.write(JSON.stringify(event) + '\n'))); cb();
    } });
    return child;
  };
}
const piArgs = { cwd: '/trusted', model: 'cursor/model', prompt: 'safe test', sessionDir: '/private', cli: '/fake.js' };
test('native Pi RPC waits for settled, not agent_end, and keeps model out of global settings', async () => {
  const commands = [];
  const result = await runPi({ ...piArgs, launch: fakePi((cmd, emit) => {
    commands.push(cmd.type);
    emit({ id: cmd.id, type: 'response', command: cmd.type, success: true });
    if (cmd.type === 'prompt') {
      emit({ type: 'agent_end' });
      emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'test answer' }] } });
      emit({ type: 'agent_settled' });
    }
  }) });
  assert.deepEqual(commands, ['set_model', 'prompt']);
  assert.deepEqual(result, { status: 'completed', result: 'test answer' });
});
test('missing native provider fails before prompting', async () => {
  const commands = [];
  const r = await runPi({ ...piArgs, launch: fakePi((cmd, emit) => {
    commands.push(cmd.type); emit({ id: cmd.id, type: 'response', success: false });
  }) });
  assert.equal(r.status, 'failed'); assert.deepEqual(commands, ['set_model']);
});
test('actual Node subprocess uses RPC pipes without shell or paid provider', async () => {
  const r = await runPi({ ...piArgs, cwd: process.cwd(), cli: fileURLToPath(new URL('./fake-pi-cli.mjs', import.meta.url)) });
  assert.deepEqual(r, { status: 'completed', result: 'native-pipe-test' });
});
test('provider errors are not successful answers or raw error exports', async () => {
  const r = await runPi({ ...piArgs, launch: fakePi((cmd, emit) => {
    emit({ id: cmd.id, type: 'response', success: true });
    if (cmd.type === 'prompt') {
      emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'secret', content: [] } });
      emit({ type: 'agent_settled' });
    }
  }) });
  assert.equal(r.status, 'failed'); assert.doesNotMatch(r.result, /secret/);
});
test('abort without settlement is uncertain, never confirmed cancellation', async () => {
  const controller = new AbortController();
  const r = await runPi({ ...piArgs, signal: controller.signal, abortGraceMs: 5,
    launch: fakePi((cmd, emit) => {
      emit({ id: cmd.id, type: 'response', success: true });
      if (cmd.type === 'prompt') controller.abort();
    }) });
  assert.equal(r.status, 'uncertain');
});
test('durable interrupted receipt blocks execution and clears only owned process lock', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-daemon-test-'));
  try {
    await writePrivate(path.join(dir, 'receipt.json'), { id: 'job', attempt: 'a' });
    assert.equal((await stat(path.join(dir, 'receipt.json'))).mode & 0o777, 0o600);
    await assert.rejects(runDaemon({ url: 'https://os.example.com', projects: [{ alias: 'test', cwd: dir, models: ['cursor/model'] }] }, {}, dir, {
      request: () => { throw Error('must not contact server'); }, execute: () => { throw Error('must not replay'); },
    }), /Interrupted execution/);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'receipt.json'), 'utf8')).id, 'job');
    await assert.rejects(access(path.join(dir, 'daemon.lock')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('durable terminal outbox replays report only, never executes Pi again', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-daemon-test-')); const controller = new AbortController();
  try {
    const report = { id: 'job', attempt: 'a', status: 'completed', result: 'answer' };
    await writePrivate(path.join(dir, 'receipt.json'), { report });
    let delivered = false;
    await runDaemon({ url: 'https://os.example.com', projects: [{ alias: 'test', cwd: dir, models: ['cursor/model'] }] }, {}, dir, {
      stopSignal: controller.signal, request: async (op, body) => {
        if (op === 'finish') { assert.deepEqual(body, report); delivered = true; controller.abort(); return {}; }
        if (op === 'catalog') return { projects: [] };
        throw Error('unexpected request');
      }, execute: () => { throw Error('must not replay'); },
    });
    assert.equal(delivered, true); await assert.rejects(access(path.join(dir, 'receipt.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('claim is journaled before execution; rejected result delivery preserves outbox', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-daemon-test-')); const controller = new AbortController();
  try {
    let executed = 0;
    await assert.rejects(runDaemon({ url: 'https://os.example.com', projects: [{ alias: 'test', cwd: dir, models: ['cursor/model'] }] }, {}, dir, {
      stopSignal: controller.signal,
      request: async op => {
        if (op === 'catalog') return { projects: [] };
        if (op === 'heartbeat') return { cancel: false };
        if (op === 'claim') return { task: { id: 'test-job', attempt: 'a', alias: 'test', model: 'cursor/model', prompt: 'safe test' } };
        if (op === 'finish') throw Error('network unavailable');
        throw Error('unexpected');
      },
      execute: async args => {
        executed++;
        assert.equal(JSON.parse(await readFile(path.join(dir, 'receipt.json'), 'utf8')).id, 'test-job');
        assert.equal(args.cwd, await (await import('node:fs/promises')).realpath(dir));
        controller.abort(); return { status: 'completed', result: 'safe test answer' };
      },
    }), /network unavailable/);
    assert.equal(executed, 1);
    const receipt = JSON.parse(await readFile(path.join(dir, 'receipt.json'), 'utf8'));
    assert.equal(receipt.report.status, 'completed');
    await assert.rejects(access(path.join(dir, 'daemon.lock')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
