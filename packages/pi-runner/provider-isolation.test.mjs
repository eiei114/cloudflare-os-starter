import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';

// Test the installed, patched PI WEB factory rather than a second implementation. No real
// credentials, normal profile, remote model request or operator extensions are used here.
const { PiSessionService } = await import(new URL(
  './node_modules/@jmfederico/pi-web/dist/server/sessions/piSessionService.js', import.meta.url));

test('each hosted session loads extensions into its own model runtime, not the catalog bootstrap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-runner-isolation-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  await mkdir(join(agentDir, 'extensions'), { recursive: true });
  await mkdir(cwd);
  await writeFile(join(agentDir, 'settings.json'), '{}');
  await writeFile(join(agentDir, 'extensions', 'session-provider.ts'), `
    export default function(pi) {
      const streamSimple = () => { throw new Error('offline test; never infer'); };
      pi.registerProvider('session-test', {
        baseUrl: 'https://example.invalid', api: 'openai-completions', apiKey: 'offline-test',
        streamSimple,
        models: [{ id: 'test', name: 'test', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 32 }]
      });
    }
  `);
  const bootstrap = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false });
  const service = new PiSessionService({ publish() {}, mediaIndex: new Map() }, { agentDir, modelRuntime: bootstrap,
    sessionManager: {}, heartbeatIntervalMs: 60000 });
  const sessions = [];
  try {
    for (let i = 0; i < 2; i++) {
      const result = await service.createRuntime({ cwd, agentDir,
        sessionManager: SessionManager.inMemory(cwd), delegationToolsEnabled: false });
      sessions.push(result.session);
    }
    assert.notEqual(sessions[0].modelRuntime, sessions[1].modelRuntime);
    assert.notEqual(sessions[0].modelRuntime, bootstrap);
    assert.equal(bootstrap.getRegisteredProviderConfig('session-test'), undefined);
    const first = sessions[0].modelRuntime.getRegisteredProviderConfig('session-test');
    const second = sessions[1].modelRuntime.getRegisteredProviderConfig('session-test');
    assert.ok(first?.streamSimple);
    assert.notEqual(first.streamSimple, second?.streamSimple);
    sessions[0].dispose();
    assert.equal(sessions[1].modelRuntime.getRegisteredProviderConfig('session-test').streamSimple, second.streamSimple);
  } finally {
    for (const session of sessions) session.dispose();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
