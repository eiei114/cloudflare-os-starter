import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { PiProjectImpl } from '../src/pi-project.js';
import { callCoordinator, emptyState, transition, type CoordinatorState, type PiCoordinator } from '../src/pi-coordinator.js';
import { fetchPiDaemon } from '../src/pi-daemon-http.js';

const owner = { owner: true };
function setup() {
  const s = emptyState();
  transition(s, 'pair-code', { hash: 'code', label: 'test', platform: 'win32' }, owner, 1);
  transition(s, 'pair', { codeHash: 'code', id: 'device', tokenHash: 'secret-hash' }, {}, 2);
  const { projects } = transition(s, 'catalog', { projects: [{ alias: 'repo', models: ['cursor/model'] }] }, { hash: 'secret-hash' }, 3) as any;
  return { s, projectId: projects[0].id, auth: { hash: 'secret-hash' } };
}
function enqueue(s: CoordinatorState, projectId: string, id = 'task') {
  return transition(s, 'enqueue', { id, projectId, prompt: 'safe test', model: 'cursor/model' }, owner, 4);
}
describe('daemon state protocol', () => {
  it('migrates legacy catalog into a stable workspace without widening execution authority', () => {
    const { s, projectId, auth } = setup();
    const before = JSON.stringify(s.projects);
    const first = transition(s, 'management', {}, owner, 4) as any;
    expect(first.workspaces).toEqual([{ id: 'personal', name: 'Personal workspace' }]);
    expect(first.projects).toHaveLength(1);
    expect(first.projects[0]).toMatchObject({ id: projectId, workspaceId: 'personal', executionProjectId: projectId });
    transition(s, 'management', {}, owner, 5);
    expect(s.managedProjects).toHaveLength(1);
    expect(JSON.stringify(s.projects)).toBe(before);
    for (const op of ['management', 'workspace-save', 'managed-project-save', 'agent-save'])
      expect(() => transition(s, op, {}, auth, 6)).toThrow();
  });
  it('persists workspace projects and agent snapshots; rejects incompatible assignments and retry collisions', () => {
    const { s, projectId, auth } = setup();
    transition(s, 'workspace-save', { id: 'work', name: 'Work' }, owner, 4);
    const project = { id: 'managed', workspaceId: 'work', name: 'Demo', description: 'Pilot',
      executionProjectId: projectId, attributes: { priority: 'normal' } };
    transition(s, 'managed-project-save', project, owner, 4);
    const agent = { id: 'agent', workspaceId: 'work', name: 'Builder', deviceId: 'device',
      model: 'cursor/model', instructions: 'Be concise', enabled: true, harness: 'pi', profile: 'local' };
    transition(s, 'agent-save', agent, owner, 4);
    const task = { id: 'assigned', projectId, managedProjectId: 'managed', agentId: 'agent', agentRevision: 1, model: 'cursor/model', prompt: 'test' };
    expect(() => transition(s, 'enqueue', { ...task, managedProjectId: projectId }, owner, 5)).toThrow('Incompatible');
    transition(s, 'enqueue', task, owner, 5);
    transition(s, 'agent-save', { ...agent, name: 'Renamed', instructions: 'Changed', enabled: false }, owner, 6);
    transition(s, 'enqueue', task, owner, 7);
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]).toMatchObject({ workspaceId: 'work', agentName: 'Builder', agentInstructions: 'Be concise' });
    expect(() => transition(s, 'enqueue', { ...task, id: 'disabled' }, owner, 7)).toThrow('Incompatible');
    expect(() => transition(s, 'enqueue', { ...task, agentRevision: 2 }, owner, 7)).toThrow('collision');
    expect(() => transition(s, 'enqueue', { ...task, agentId: undefined }, owner, 7)).toThrow('collision');
    expect((transition(s, 'claim', { attempt: 'a' }, auth, 8) as any).task.prompt).toBe('Be concise\n\n--- Task ---\ntest');
    expect((transition(s, 'tasks', {}, owner, 9) as any).tasks[0]).not.toHaveProperty('agentInstructions');
    expect(transition(s, 'task', { id: 'assigned', projectId }, owner, 9)).not.toHaveProperty('agentInstructions');
    const restored = JSON.parse(JSON.stringify(s));
    expect((transition(restored, 'management', {}, owner, 10) as any).projects).toContainEqual(project);
    for (const bad of [{ workspaceId: 'missing' }, { workspaceId: 'personal' }, { executionProjectId: '/tmp/arbitrary' },
      { attributes: { invalid: 1 } }, { attributes: [] }, { attributes: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i, 'x'])) }])
      expect(() => transition(s, 'managed-project-save', { ...project, ...bad }, owner, 10)).toThrow();
    for (const bad of [{ model: 'openai/unregistered' }, { deviceId: 'missing' }, { harness: 'shell' }, { profile: '/tmp/profile' },
      { instructions: 'x'.repeat(4001) }, { enabled: 'yes' }, { workspaceId: 'personal' }])
      expect(() => transition(s, 'agent-save', { ...agent, ...bad }, owner, 10)).toThrow();
  });
  it('pairing is one-use, expires, and never exposes stored credential hashes', () => {
    const { s } = setup();
    expect(() => transition(s, 'pair', { codeHash: 'code' }, {}, 4)).toThrow();
    expect(JSON.stringify(transition(s, 'inventory', {}, owner, 4))).not.toContain('secret-hash');
    transition(s, 'pair-code', { hash: 'expired', label: 'test', platform: 'darwin' }, owner, 4);
    expect(() => transition(s, 'pair', { codeHash: 'expired' }, {}, 300_005)).toThrow();
  });
  it('device credential cannot submit work or operate another device', () => {
    const { s, projectId, auth } = setup();
    expect(() => transition(s, 'enqueue', { projectId, id: 'x' }, auth, 4)).toThrow();
    expect(() => transition(s, 'claim', { attempt: 'a' }, { hash: 'wrong' }, 4)).toThrow();
    expect(() => transition(s, 'revoke', { deviceId: 'device' }, auth, 4)).toThrow();
  });
  it('enforces immutable alias/model allowlists and idempotent submission', () => {
    const { s, projectId, auth } = setup();
    enqueue(s, projectId); enqueue(s, projectId);
    expect(s.tasks).toHaveLength(1);
    expect(() => transition(s, 'enqueue', { projectId, id: 'wrong-model', prompt: 'test', model: 'openai/other' }, owner, 5)).toThrow();
    expect(() => transition(s, 'catalog', { projects: [{ alias: 'repo', models: ['openai/other'] }] }, auth, 5)).toThrow();
  });
  it('one active slot, attempt fence and late-completion denial', () => {
    const { s, projectId, auth } = setup(); enqueue(s, projectId); enqueue(s, projectId, 'next');
    expect(transition(s, 'claim', { attempt: 'a' }, auth, 5)).toMatchObject({ task: { id: 'task' } });
    expect(transition(s, 'claim', { attempt: 'b' }, auth, 6)).toEqual({ task: null });
    expect(() => transition(s, 'heartbeat', { id: 'task', attempt: 'b' }, auth, 6)).toThrow();
    expect(transition(s, 'claim', { attempt: 'b' }, auth, 45_006)).toEqual({ task: null });
    expect(s.tasks[0].status).toBe('uncertain');
    expect(() => transition(s, 'finish', { id: 'task', attempt: 'a', status: 'completed', result: 'late' }, auth, 45_006)).toThrow();
  });
  it('cancellation request is not acknowledgement; exact final report is idempotent', () => {
    const { s, projectId, auth } = setup(); enqueue(s, projectId);
    transition(s, 'claim', { attempt: 'a' }, auth, 5);
    transition(s, 'cancel', { projectId, id: 'task' }, owner, 6);
    expect(s.tasks[0].status).toBe('cancel-requested');
    expect(transition(s, 'heartbeat', { id: 'task', attempt: 'a', progress: 'stopping' }, auth, 7)).toMatchObject({ cancel: true });
    const final = { id: 'task', attempt: 'a', status: 'cancelled', result: 'Stopped' };
    transition(s, 'finish', final, auth, 8); transition(s, 'finish', final, auth, 9);
    expect(s.tasks[0].status).toBe('cancelled');
    expect(() => transition(s, 'finish', { ...final, result: 'changed' }, auth, 10)).toThrow();
  });
  it('revocation fences running work and prevents new tasks', () => {
    const { s, projectId, auth } = setup(); enqueue(s, projectId);
    transition(s, 'claim', { attempt: 'a' }, auth, 5);
    transition(s, 'revoke', { deviceId: 'device' }, owner, 6);
    expect(s.tasks[0].status).toBe('uncertain');
    expect(() => transition(s, 'heartbeat', {}, auth, 7)).toThrow();
    expect(() => enqueue(s, projectId, 'later')).toThrow();
  });
  it('does not return cross-project task data', () => {
    const { s, projectId } = setup(); enqueue(s, projectId);
    expect(transition(s, 'task', { id: 'task', projectId: 'other' }, owner, 5)).toBeNull();
    const status = transition(s, 'task', { id: 'task', projectId }, owner, 5);
    expect(status).not.toHaveProperty('prompt');
  });
  it('owner task list is bounded metadata, never prompts, results or lease credentials', () => {
    const { s, projectId, auth } = setup(); enqueue(s, projectId);
    transition(s, 'claim', { attempt: 'private-attempt' }, auth, 5);
    transition(s, 'finish', { id: 'task', attempt: 'private-attempt', status: 'completed', result: 'private-result' }, auth, 6);
    const list = transition(s, 'tasks', {}, owner, 7) as any;
    expect(list.tasks[0]).toMatchObject({ id: 'task', status: 'completed', source: 'os-approval' });
    for (const field of ['prompt', 'result', 'attempt', 'leaseUntil']) expect(list.tasks[0]).not.toHaveProperty(field);
    expect(() => transition(s, 'tasks', {}, auth, 7)).toThrow();
  });
  it('kanban review is owner-only, idempotent and never rewrites execution status', () => {
    const { s, projectId, auth } = setup();
    const data = { id: 'board-task', projectId, model: 'cursor/model', prompt: 'test', title: '<unsafe title>', source: 'owner-ui' };
    transition(s, 'enqueue', data, owner, 4);
    expect(() => transition(s, 'enqueue', { ...data, title: 'changed' }, owner, 4)).toThrow();
    expect(() => transition(s, 'review', data, owner, 5)).toThrow();
    transition(s, 'claim', { attempt: 'a' }, auth, 5);
    transition(s, 'finish', { id: data.id, attempt: 'a', status: 'completed', result: 'ok' }, auth, 6);
    expect(() => transition(s, 'review', data, auth, 7)).toThrow();
    transition(s, 'review', data, owner, 7); transition(s, 'review', data, owner, 8);
    expect(s.tasks[0]).toMatchObject({ status: 'completed', title: '<unsafe title>', reviewedAt: 7 });
    expect(transition(s, 'task', data, owner, 8)).not.toHaveProperty('reviewedAt');
    expect(transition(s, 'task', data, owner, 8)).not.toHaveProperty('title');
    expect((transition(s, 'tasks', {}, owner, 8) as any).tasks[0]).toMatchObject({ reviewedAt: 7 });
    expect(transition(s, 'claim', { attempt: 'new' }, auth, 8)).toEqual({ task: null });
  });
});

const testEnv = env as unknown as { PI_COORDINATOR: DurableObjectNamespace<PiCoordinator>;
  PI_TEST_PARENT: DurableObjectNamespace<{ scenario(id: string, mode: string): Promise<string> }> };
async function pairedProject() {
  const code = crypto.randomUUID(), hash = crypto.randomUUID();
  await callCoordinator(testEnv, 'pair-code', { hash: code, label: 'test', platform: 'darwin' }, owner);
  await callCoordinator(testEnv, 'pair', { codeHash: code, id: crypto.randomUUID(), tokenHash: hash }, {});
  const { projects } = await callCoordinator(testEnv, 'catalog', { projects: [{ alias: 'test', models: ['cursor/model'] }] }, { hash });
  return { projectId: projects[0].id, hash };
}
describe('real workerd approval facet', () => {
  it('stores management metadata and immutable agent execution snapshots in real DO transactions', async () => {
    const { projectId, hash } = await pairedProject();
    const inventory = await callCoordinator(testEnv, 'inventory', {}, owner);
    const deviceId = inventory.projects.find((p: any) => p.id === projectId).deviceId;
    const workspaceId = crypto.randomUUID(), managedProjectId = crypto.randomUUID(), agentId = crypto.randomUUID();
    await callCoordinator(testEnv, 'workspace-save', { id: workspaceId, name: 'DO workspace' }, owner);
    await callCoordinator(testEnv, 'managed-project-save', { id: managedProjectId, workspaceId, name: 'DO project',
      description: '', attributes: { category: 'test' }, executionProjectId: projectId }, owner);
    const agent = { id: agentId, workspaceId, name: 'DO agent', deviceId, model: 'cursor/model',
      instructions: 'Initial role', enabled: true, harness: 'pi', profile: 'local' };
    await callCoordinator(testEnv, 'agent-save', agent, owner);
    const data = { id: crypto.randomUUID(), projectId, managedProjectId, agentId, agentRevision: 1, model: 'cursor/model', prompt: 'test' };
    await callCoordinator(testEnv, 'enqueue', data, owner);
    await callCoordinator(testEnv, 'agent-save', { ...agent, instructions: 'New role' }, owner);
    await expect(callCoordinator(testEnv, 'enqueue', { ...data, id: crypto.randomUUID() }, owner)).rejects.toThrow();
    // Failed transactions neither enqueue nor mutate previously approved settings.
    const metadata = await callCoordinator(testEnv, 'management', {}, owner);
    expect(metadata.agents.find((a: any) => a.id === agentId)).toMatchObject({ revision: 2, instructions: 'New role' });
    const claim = await callCoordinator(testEnv, 'claim', { attempt: crypto.randomUUID() }, { hash });
    expect(claim.task).toMatchObject({ id: data.id, workspaceId, agentName: 'DO agent', prompt: 'Initial role\n\n--- Task ---\ntest' });
  });
  for (const mode of ['apply', 'cancel-first', 'reject']) it(`simulates before approval and handles ${mode}`, async () => {
    const { projectId, hash } = await pairedProject();
    const r = JSON.parse(await testEnv.PI_TEST_PARENT.getByName(crypto.randomUUID()).scenario(projectId, mode));
    expect(r.before.status).toBe('pending');
    expect(r.after.status).toBe(mode === 'apply' ? 'queued' : 'cancelled');
    expect(r.observerDenied).toBe(true);
    const claim = await callCoordinator(testEnv, 'claim', { attempt: crypto.randomUUID() }, { hash });
    expect(Boolean(claim.task)).toBe(mode === 'apply');
  });
  it('serializes concurrent device claims durably', async () => {
    const { projectId, hash } = await pairedProject();
    await callCoordinator(testEnv, 'enqueue', { id: crypto.randomUUID(), projectId, prompt: 'test' }, owner);
    const results = await Promise.all([1, 2, 3].map(() => callCoordinator(testEnv, 'claim', { attempt: crypto.randomUUID() }, { hash })));
    expect(results.filter(r => r.task)).toHaveLength(1);
  });
});

describe('HTTP fail-closed boundaries', () => {
  const base = 'https://os.example.com';
  const e = { ...testEnv, PI_DAEMON_ENABLED: true, PUBLIC_BASE_URL: base };
  it('disabled, nonmatching and anonymous routes', async () => {
    expect(await fetchPiDaemon(new Request(base + '/unrelated'), e)).toBeUndefined();
    expect((await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/device/claim'), {}))?.status).toBe(503);
    expect((await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/device/claim', { method: 'POST' }), e))?.status).toBe(401);
  });
  it('rejects browser cookies, Origin, unknown operations and oversized streaming input', async () => {
    for (const headers of [{ cookie: 'owner=1' }, { origin: base }]) {
      const r = await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/device/pair', { method: 'POST', headers }), e);
      expect(r?.status).toBe(403);
    }
    const big = await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/device/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(100_001) }), e);
    expect(big?.status).toBe(413);
    // An empty edge-added header carries no browser identity or Origin authority.
    expect((await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/device/claim', { method: 'POST',
      headers: { cookie: '', origin: '' } }), e))?.status).toBe(401);
    expect((await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/enqueue', { method: 'POST' }), e))?.status).toBe(404);
    for (const op of ['claim', 'pair', 'heartbeat']) expect((await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/' + op, { method: 'POST' }), e))?.status).toBe(404);
    for (const op of ['submit', 'tasks', 'cancel', 'review', 'inventory', 'pair-code', 'management', 'workspace-save', 'managed-project-save', 'agent-save', 'github-repos']) {
      expect((await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/device/' + op, { method: 'POST' }), e))?.status).toBe(404);
      expect((await fetchPiDaemon(new Request(base + '/gatekeeper/custom/runner/' + op, { method: 'POST',
        headers: { origin: base, authorization: 'Bearer ' + 'a'.repeat(64) } }), e))?.status).toBe(403);
    }
  });
});

describe('owner portal and observation enforcement', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('requires a device-app service assertion and ignores only its injected Access cookie', async () => {
    const keys = await generateKeyPair('RS256');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [{ ...await exportJWK(keys.publicKey),
      kid: 'device-service', alg: 'RS256', use: 'sig' }] })));
    const e = { ...testEnv, PI_DAEMON_ENABLED: true, PUBLIC_BASE_URL: 'https://os.example.com',
      CF_ACCESS_ISS: 'https://device-service-test.cloudflareaccess.com', CF_ACCESS_AUD: 'owner-aud',
      PI_DAEMON_ACCESS_AUD: 'device-aud', ADMINS: ['owner@example.com'] };
    const token = (payload: Record<string, unknown>, aud = e.PI_DAEMON_ACCESS_AUD) => new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'device-service' }).setIssuer(e.CF_ACCESS_ISS)
      .setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const request = (jwt?: string, cookie = 'CF_Authorization=edge-injected', code = '') => fetchPiDaemon(new Request(
      e.PUBLIC_BASE_URL + '/gatekeeper/custom/runner/device/pair', { method: 'POST',
        headers: { 'content-type': 'application/json', cookie, ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}) },
        body: JSON.stringify({ code }) }), e);
    expect((await request())?.status).toBe(401);
    const service = await token({ common_name: 'dedicated-service', type: 'app' });
    expect((await request(service, 'owner=browser'))?.status).toBe(403);
    expect((await request(await token({ common_name: 'dedicated-service' }, e.CF_ACCESS_AUD)))?.status).toBe(400);
    expect((await request(await token({ common_name: 'dedicated-service', email: 'owner@example.com' })))?.status).toBe(403);
    const code = 'b'.repeat(64);
    const { digest } = await import('../src/pi-coordinator.js');
    await callCoordinator(testEnv, 'pair-code', { hash: await digest(code), label: 'service-test', platform: 'darwin' }, owner);
    expect((await request(service, 'CF_Authorization=edge-injected', code))?.status).toBe(200);
    // Cookie alone is never authority, even after successful pairing.
    expect((await request(undefined, 'CF_Authorization=edge-injected', code))?.status).toBe(401);
  });
  it('checks JWT owner and audience before issuing a code; paired device remains separate', async () => {
    const keys = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(keys.publicKey), kid: 'daemon-test', alg: 'RS256', use: 'sig' };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [jwk] })));
    const e = { ...testEnv, PI_DAEMON_ENABLED: true, PUBLIC_BASE_URL: 'https://os.example.com',
      CF_ACCESS_ISS: 'https://daemon-test.cloudflareaccess.com', CF_ACCESS_AUD: 'daemon-aud', ADMINS: ['owner@example.com'] };
    const token = (email: string, aud = e.CF_ACCESS_AUD) => new SignJWT({ email })
      .setProtectedHeader({ alg: 'RS256', kid: 'daemon-test' }).setIssuer(e.CF_ACCESS_ISS)
      .setAudience(aud).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    const req = (jwt: string) => new Request(e.PUBLIC_BASE_URL + '/gatekeeper/custom/runner/pair-code', {
      method: 'POST', headers: { 'cf-access-jwt-assertion': jwt, origin: e.PUBLIC_BASE_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'jwt-test', platform: 'win32' }),
    });
    expect((await fetchPiDaemon(req(await token('stranger@example.com')), e))?.status).toBe(403);
    expect((await fetchPiDaemon(req(await token('owner@example.com', 'wrong')), e))?.status).toBe(400);
    const r = await fetchPiDaemon(req(await token('owner@example.com')), e);
    expect(r?.status).toBe(200); const code = (await r!.json() as any).code;
    const pairReq = () => new Request(e.PUBLIC_BASE_URL + '/gatekeeper/custom/runner/device/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    expect((await fetchPiDaemon(pairReq(), e))?.status).toBe(200);
    expect((await fetchPiDaemon(pairReq(), e))?.status).toBe(400);
    const portal = await fetchPiDaemon(new Request(e.PUBLIC_BASE_URL + '/gatekeeper/custom/runner/', {
      headers: { 'cf-access-jwt-assertion': await token('owner@example.com') },
    }), e);
    expect(portal?.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(portal?.headers.get('cache-control')).toBe('no-store');
    const html = await portal!.text();
    expect(html).toContain('承認して実行待ちに追加');
    expect(html).toContain('タスクボード');
    for (const label of ['ワークスペース', 'プロジェクト', 'エージェント', 'ランタイム', '役割・追加指示']) expect(html).toContain(label);
    for (const label of ['実行待ち', '実行中', '確認待ち', '完了', '停止・要対応']) expect(html).toContain(label);
    expect(html).not.toContain('innerHTML');
    // Parse the actual emitted owner script, not a separately maintained copy.
    expect(() => new Function(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1])).not.toThrow();
    const { projectId } = await pairedProject();
    const jwt = await token('owner@example.com');
    const post = (op: string, body: unknown, origin = e.PUBLIC_BASE_URL) => fetchPiDaemon(new Request(
      e.PUBLIC_BASE_URL + '/gatekeeper/custom/runner/' + op, { method: 'POST',
        headers: { 'cf-access-jwt-assertion': jwt, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), e);
    const task = { id: crypto.randomUUID(), projectId, model: 'cursor/model', prompt: 'owner test', title: 'Owner test', approved: true };
    expect((await post('submit', { ...task, approved: false }))?.status).toBe(400);
    expect((await post('submit', task, 'https://evil.example'))?.status).toBe(403);
    expect((await post('submit', { ...task, model: 'openai/not-allowed' }))?.status).toBe(400);
    expect((await post('submit', task))?.status).toBe(200);
    expect((await post('submit', task))?.status).toBe(200);
    expect((await post('review', task))?.status).toBe(400);
    const list = await (await post('tasks', {}))!.json() as any;
    expect(list.tasks.filter((t: any) => t.id === task.id)).toHaveLength(1);
    expect(list.tasks.find((t: any) => t.id === task.id)).toMatchObject({ source: 'owner-ui', status: 'queued', title: 'Owner test' });
    expect((await post('cancel', task))?.status).toBe(200);
    expect(await (await post('task', task))!.json()).toMatchObject({ status: 'cancelled' });
    const serviceJwt = await new SignJWT({ type: 'app', common_name: 'service-token' })
      .setProtectedHeader({ alg: 'RS256', kid: 'daemon-test' }).setIssuer(e.CF_ACCESS_ISS)
      .setAudience(e.CF_ACCESS_AUD).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    expect((await fetchPiDaemon(new Request(e.PUBLIC_BASE_URL + '/gatekeeper/custom/runner/tasks', { method: 'POST',
      headers: { 'cf-access-jwt-assertion': serviceJwt, origin: e.PUBLIC_BASE_URL, 'content-type': 'application/json' }, body: '{}' }), e))?.status).toBe(400);
  });
  it('does not return a project or task when observation authorization fails', async () => {
    const project = vi.fn();
    const session = new PiProjectImpl({ project } as any, {
      authorizeObservation: async () => { throw new Error('denied'); },
    } as any);
    await expect(session.getStatus()).rejects.toThrow('denied');
    await expect(session.getTask('task')).rejects.toThrow('denied');
    expect(project).not.toHaveBeenCalled();
  });
});
