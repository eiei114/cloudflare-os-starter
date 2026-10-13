import { DurableObject } from 'cloudflare:workers';
import { repoName, type GitHubRepoLink } from './github-projects.js';

export type Project = { id: string; deviceId: string; alias: string; models: string[] };
export type Workspace = { id: string; name: string };
export type ManagedProject = { id: string; workspaceId: string; name: string; description: string;
  executionProjectId?: string; attributes: Record<string, string>; github?: GitHubRepoLink };
export type Agent = { id: string; workspaceId: string; name: string; deviceId: string;
  model: string; instructions: string; enabled: boolean; harness: 'pi'; profile: 'local'; revision: number };
export type TaskRecord = {
  id: string; projectId: string; prompt: string; model: string;
  status: 'queued' | 'running' | 'cancel-requested' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  attempt?: string; leaseUntil?: number; progress?: string; result?: string;
  createdAt?: number;
  source?: 'owner-ui' | 'os-approval';
  title?: string;
  reviewedAt?: number;
  workspaceId?: string; managedProjectId?: string; agentId?: string; agentName?: string; agentInstructions?: string; agentRevision?: number;
};
type Device = { id: string; label: string; platform: string; tokenHash: string; revoked: boolean; seen: number };
export type CoordinatorState = {
  devices: Device[]; projects: Project[]; tasks: TaskRecord[];
  pairs: { hash: string; expires: number; label: string; platform: string }[];
  workspaces?: Workspace[]; managedProjects?: ManagedProject[]; agents?: Agent[];
};
export const emptyState = (): CoordinatorState => ({ devices: [], projects: [], tasks: [], pairs: [] });
const active = (t: TaskRecord) => t.status === 'running' || t.status === 'cancel-requested';
const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || new TextEncoder().encode(v).length > max) throw new Error('Invalid input');
  return v;
};
const optionalText = (v: unknown, max: number) => v === '' || v === undefined ? '' : text(v, max);
function initializeManagement(s: CoordinatorState) {
  s.workspaces ??= [{ id: 'personal', name: 'Personal workspace' }];
  s.managedProjects ??= [];
  s.agents ??= [];
  // Stable legacy mapping. Never change the device-owned execution catalog.
  for (const p of s.projects) if (!s.managedProjects.some(m => m.id === p.id) && s.managedProjects.length < 60) {
    s.managedProjects.push({ id: p.id, workspaceId: 'personal', name: p.alias,
      description: '', executionProjectId: p.id, attributes: {} });
  }
}
export async function digest(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Pure state transition. DO transaction serializes every claim, renewal and terminal report. */
export function transition(s: CoordinatorState, op: string, data: Record<string, unknown>,
  auth: { owner?: boolean; hash?: string }, now: number): unknown {
  // Unknown execution is terminal: never offer an expired attempt to another daemon.
  for (const t of s.tasks) if (active(t) && (t.leaseUntil ?? 0) <= now) t.status = 'uncertain';
  s.pairs = s.pairs.filter(p => p.expires > now);
  if (op === 'pair-code' && auth.owner) {
    if (s.pairs.length >= 10) throw new Error('Pairing limit');
    s.pairs.push({ hash: text(data.hash, 64), expires: now + 300_000,
      label: text(data.label, 80), platform: text(data.platform, 20) });
    return { expires: now + 300_000 };
  }
  if (op === 'pair') {
    const i = s.pairs.findIndex(p => p.hash === data.codeHash);
    if (i < 0) throw new Error('Invalid pairing code');
    if (s.devices.length >= 20) throw new Error('Device limit');
    const p = s.pairs.splice(i, 1)[0];
    const d = { id: text(data.id, 64), tokenHash: text(data.tokenHash, 64),
      label: p.label, platform: p.platform, revoked: false, seen: now };
    s.devices.push(d);
    return { deviceId: d.id };
  }
  if (auth.owner) {
    initializeManagement(s);
    const workspace = (id: unknown) => {
      const w = s.workspaces!.find(candidate => candidate.id === id);
      if (!w) throw new Error('Unknown workspace');
      return w;
    };
    if (op === 'management') return { workspaces: s.workspaces, projects: s.managedProjects, agents: s.agents };
    if (op === 'workspace-save') {
      const id = text(data.id, 64); const name = text(data.name, 120);
      const prior = s.workspaces!.find(w => w.id === id);
      if (prior) prior.name = name;
      else { if (s.workspaces!.length >= 20) throw new Error('Workspace limit'); s.workspaces!.push({ id, name }); }
      return { id };
    }
    if (op === 'managed-project-save') {
      const id = text(data.id, 64); const w = workspace(data.workspaceId);
      const execution = s.projects.find(p => p.id === data.executionProjectId);
      if (data.executionProjectId !== undefined && (!execution || s.devices.find(d => d.id === execution.deviceId)?.revoked !== false)) throw new Error('Unavailable execution target');
      if (!data.attributes || typeof data.attributes !== 'object' || Array.isArray(data.attributes)) throw new Error('Invalid attributes');
      const entries = Object.entries(data.attributes);
      if (entries.length > 10) throw new Error('Attribute limit');
      const attributes = Object.fromEntries(entries.map(([k, v]) => [text(k, 80), text(v, 300)]));
      const prior = s.managedProjects!.find(p => p.id === id);
      // Project membership is stable; moving queued/history across workspaces is unsupported.
      if (prior && prior.workspaceId !== w.id) throw new Error('Workspace mismatch');
      const github = data.github as GitHubRepoLink | undefined;
      if (github && (!Number.isSafeInteger(github.accountId) || github.accountId <= 0 || !Number.isFinite(github.verifiedAt))) throw new Error('Invalid GitHub link');
      const value: ManagedProject = { id, workspaceId: w.id, name: text(data.name, 120),
        description: optionalText(data.description, 1000), executionProjectId: execution?.id, attributes,
        github: github ? { accountId: github.accountId, fullName: repoName(github.fullName), verifiedAt: github.verifiedAt } : undefined };
      if (prior) Object.assign(prior, value);
      else { if (s.managedProjects!.length >= 60) throw new Error('Project limit'); s.managedProjects!.push(value); }
      return { id };
    }
    if (op === 'agent-save') {
      const id = text(data.id, 64); const w = workspace(data.workspaceId);
      const device = s.devices.find(d => d.id === data.deviceId && !d.revoked);
      const model = text(data.model, 200);
      if (!device || !s.projects.some(p => p.deviceId === device.id && p.models.includes(model))) throw new Error('Unavailable runtime/model');
      if (typeof data.enabled !== 'boolean' || data.harness !== 'pi' || data.profile !== 'local') throw new Error('Unsupported execution settings');
      const prior = s.agents!.find(a => a.id === id);
      if (prior && prior.workspaceId !== w.id) throw new Error('Workspace mismatch');
      const value: Agent = { id, workspaceId: w.id, name: text(data.name, 120), deviceId: device.id, model,
        instructions: optionalText(data.instructions, 4000), enabled: data.enabled, harness: 'pi', profile: 'local', revision: (prior?.revision ?? 0) + 1 };
      if (prior) Object.assign(prior, value);
      else { if (s.agents!.length >= 40) throw new Error('Agent limit'); s.agents!.push(value); }
      return { id };
    }
    if (op === 'inventory') return { devices: s.devices.map(({ tokenHash: _, ...d }) => d), projects: s.projects };
    if (op === 'tasks') return { tasks: s.tasks.toSorted((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map(({ prompt: _, result: __, attempt: ___, leaseUntil: ____, agentInstructions: _____, ...task }) => task) };
    if (op === 'revoke') {
      const d = s.devices.find(candidate => candidate.id === data.deviceId);
      if (!d) throw new Error('Unknown device');
      d.revoked = true;
      for (const t of s.tasks.filter(candidate => s.projects.find(p => p.id === candidate.projectId)?.deviceId === d.id)) {
        if (active(t)) t.status = 'uncertain';
        if (t.status === 'queued') t.status = 'cancelled';
      }
      return {};
    }
    if (op === 'project') {
      const p = s.projects.find(candidate => candidate.id === data.projectId);
      if (!p) return null;
      const device = s.devices.find(candidate => candidate.id === p.deviceId)!;
      return { ...p, deviceStatus: device.revoked ? 'revoked' : now - device.seen < 45_000 ? 'online' : 'offline', lastSeen: device.seen };
    }
    if (op === 'enqueue') {
      // Caller supplies a durable id: retrying approval cannot create a second job.
      const prior = s.tasks.find(t => t.id === data.id);
      if (prior) {
        if (prior.projectId !== data.projectId || prior.prompt !== data.prompt || prior.model !== data.model ||
            (prior.title ?? '') !== (data.title ?? '') || (prior.agentId ?? '') !== (data.agentId ?? '') ||
            prior.agentRevision !== data.agentRevision ||
            (data.managedProjectId !== undefined && prior.managedProjectId !== data.managedProjectId))
          throw new Error('Task id collision');
        return prior;
      }
      const p = s.projects.find(candidate => candidate.id === data.projectId);
      if (!p || s.devices.find(d => d.id === p.deviceId)?.revoked !== false) throw new Error('Unavailable project');
      const model = data.model ?? p.models[0];
      if (!p.models.includes(model as string)) throw new Error('Model not locally allowed');
      const managed = s.managedProjects!.find(m => m.id === (data.managedProjectId ?? p.id));
      if (!managed || managed.executionProjectId !== p.id) throw new Error('Project binding mismatch');
      const agent = data.agentId === undefined ? undefined : s.agents!.find(a => a.id === data.agentId);
      if (data.agentId !== undefined && (!agent || !agent.enabled || agent.workspaceId !== managed.workspaceId ||
          agent.deviceId !== p.deviceId || agent.model !== model || agent.revision !== data.agentRevision)) throw new Error('Incompatible agent');
      const prompt = text(data.prompt, 32_000);
      if (agent?.instructions) text(agent.instructions + '\n\n--- Task ---\n' + prompt, 32_000);
      if (s.tasks.length >= 100) throw new Error('MVP task history limit; archive support required before accepting more');
      const t: TaskRecord = { id: text(data.id, 64), projectId: p.id,
        prompt, model: model as string, status: 'queued', createdAt: now,
        workspaceId: managed.workspaceId, managedProjectId: managed.id,
        ...(agent ? { agentId: agent.id, agentName: agent.name, agentInstructions: agent.instructions, agentRevision: agent.revision } : {}),
        source: data.source === 'owner-ui' ? 'owner-ui' : 'os-approval',
        ...(data.title === undefined ? {} : { title: text(data.title, 200) }) };
      s.tasks.push(t);
      return t;
    }
    if (op === 'task' || op === 'cancel' || op === 'review') {
      const t = s.tasks.find(candidate => candidate.id === data.id && candidate.projectId === data.projectId);
      if (!t && op === 'task') return null;
      if (!t) throw new Error('Unknown task');
      if (op === 'cancel') {
        if (t.status === 'queued') t.status = 'cancelled';
        if (t.status === 'running') t.status = 'cancel-requested';
      }
      if (op === 'review') {
        // Human acknowledgement only. Never rewrite execution status or clear uncertainty.
        if (t.status !== 'completed') throw new Error('Only completed execution may be reviewed');
        t.reviewedAt ??= now;
      }
      const { prompt: _, attempt: __, leaseUntil: ___, createdAt: ____, title: _____, reviewedAt: ______,
        agentInstructions: _______, ...status } = t;
      return status;
    }
  }
  const d = s.devices.find(candidate => !candidate.revoked && candidate.tokenHash === auth.hash);
  if (!d) throw new Error('Device authentication failed');
  d.seen = now;
  const deviceTasks = s.tasks.filter(t => s.projects.find(p => p.id === t.projectId)?.deviceId === d.id);
  if (op === 'catalog') {
    if (!Array.isArray(data.projects) || data.projects.length > 20) throw new Error('Invalid catalog');
    // Registration is additive and immutable. Changes require revocation/new pairing, not silent authority widening.
    for (const raw of data.projects as Record<string, unknown>[]) {
      const alias = text(raw.alias, 80);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(alias) || !Array.isArray(raw.models) || !raw.models.length || raw.models.length > 20)
        throw new Error('Invalid project');
      const models = raw.models.map(m => text(m, 200));
      if (models.some(m => !/^[^\s/]+\/[^\s]+$/.test(m))) throw new Error('Invalid model');
      const p = s.projects.find(candidate => candidate.deviceId === d.id && candidate.alias === alias);
      if (p && JSON.stringify(p.models) !== JSON.stringify(models)) throw new Error('Re-pair to change models');
      if (!p) {
        if (s.projects.length >= 20) throw new Error('Project limit');
        s.projects.push({ id: crypto.randomUUID(), deviceId: d.id, alias, models });
      }
    }
    return { projects: s.projects.filter(p => p.deviceId === d.id) };
  }
  if (op === 'claim') {
    if (deviceTasks.some(t => active(t) || t.status === 'uncertain')) return { task: null };
    const t = deviceTasks.filter(candidate => candidate.status === 'queued')
      .toSorted((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))[0];
    if (!t) return { task: null };
    t.status = 'running'; t.attempt = text(data.attempt, 64); t.leaseUntil = now + 45_000;
    return { task: { ...t, prompt: t.agentInstructions ? t.agentInstructions + '\n\n--- Task ---\n' + t.prompt : t.prompt,
      alias: s.projects.find(p => p.id === t.projectId)!.alias } };
  }
  if (op === 'heartbeat' && !data.id) return {};
  const t = deviceTasks.find(candidate => candidate.id === data.id && candidate.attempt === data.attempt);
  if (!t) throw new Error('Attempt fence mismatch');
  if (op === 'finish') {
    const status = data.status;
    if (!['completed', 'failed', 'cancelled', 'uncertain'].includes(status as string)) throw new Error('Invalid terminal status');
    // Idempotent only for an identical report; late results cannot resurrect an expired lease.
    if (!active(t)) {
      if (t.status === status && t.result === data.result) return {};
      throw new Error('Attempt no longer active');
    }
    if (typeof data.result !== 'string' || new TextEncoder().encode(data.result).length > 32_000) throw new Error('Invalid result');
    t.status = status as TaskRecord['status']; t.result = data.result;
    return {};
  }
  if (op === 'heartbeat' && active(t)) {
    t.leaseUntil = now + 45_000;
    if (data.progress !== undefined) {
      if (!['starting', 'thinking', 'tool', 'settled', 'stopping'].includes(data.progress as string)) throw new Error('Invalid progress');
      t.progress = data.progress as string;
    }
    return { cancel: t.status === 'cancel-requested', leaseUntil: t.leaseUntil };
  }
  throw new Error('Operation denied');
}

export class PiCoordinator extends DurableObject<Cloudflare.Env> {
  async command(op: string, dataJson: string, auth: { owner?: boolean; hash?: string }): Promise<string> {
    return this.ctx.storage.transaction(async tx => {
      const stored = await tx.get<CoordinatorState>('state');
      const priorMetadata = JSON.stringify(stored);
      const state = stored ?? emptyState();
      const priorTasks = await tx.list<TaskRecord>({ prefix: 'task:' });
      const priorJson = new Map([...priorTasks].map(([key, task]) => [key, JSON.stringify(task)]));
      state.tasks = [...priorTasks.values()];
      const result = transition(state, op, JSON.parse(dataJson), auth, Date.now());
      // Each bounded task has its own KV record; do not put history into a single 128KiB value.
      for (const task of state.tasks) {
        const key = `task:${task.id}`;
        if (priorJson.get(key) !== JSON.stringify(task)) await tx.put(key, task);
      }
      const metadata = { ...state, tasks: [] };
      const metadataJson = JSON.stringify(metadata);
      if (new TextEncoder().encode(metadataJson).length > 90_000) throw new Error('Metadata storage limit');
      // Read-only observations still persist lease expiry/legacy initialization,
      // but an unchanged snapshot must not rewrite the metadata row.
      if (priorMetadata !== metadataJson) await tx.put('state', metadata);
      return JSON.stringify(result);
    });
  }
}

export async function callCoordinator(env: { PI_COORDINATOR?: DurableObjectNamespace<PiCoordinator> },
  op: string, data: unknown, auth: { owner?: boolean; hash?: string }): Promise<any> {
  if (!env.PI_COORDINATOR) throw new Error('Coordinator unavailable');
  return JSON.parse(await env.PI_COORDINATOR.getByName('owner').command(op, JSON.stringify(data), auth));
}
