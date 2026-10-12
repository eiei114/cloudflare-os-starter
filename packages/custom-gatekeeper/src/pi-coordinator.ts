import { DurableObject } from 'cloudflare:workers';

export type Project = { id: string; deviceId: string; alias: string; models: string[] };
export type TaskRecord = {
  id: string; projectId: string; prompt: string; model: string;
  status: 'queued' | 'running' | 'cancel-requested' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  attempt?: string; leaseUntil?: number; progress?: string; result?: string;
  createdAt?: number;
  source?: 'owner-ui' | 'os-approval';
  title?: string;
  reviewedAt?: number;
};
type Device = { id: string; label: string; platform: string; tokenHash: string; revoked: boolean; seen: number };
export type CoordinatorState = {
  devices: Device[]; projects: Project[]; tasks: TaskRecord[];
  pairs: { hash: string; expires: number; label: string; platform: string }[];
};
export const emptyState = (): CoordinatorState => ({ devices: [], projects: [], tasks: [], pairs: [] });
const active = (t: TaskRecord) => t.status === 'running' || t.status === 'cancel-requested';
const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || new TextEncoder().encode(v).length > max) throw new Error('Invalid input');
  return v;
};
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
    if (op === 'inventory') return { devices: s.devices.map(({ tokenHash: _, ...d }) => d), projects: s.projects };
    if (op === 'tasks') return { tasks: s.tasks.toSorted((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .map(({ prompt: _, result: __, attempt: ___, leaseUntil: ____, ...task }) => task) };
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
            (prior.title ?? '') !== (data.title ?? ''))
          throw new Error('Task id collision');
        return prior;
      }
      const p = s.projects.find(candidate => candidate.id === data.projectId);
      if (!p || s.devices.find(d => d.id === p.deviceId)?.revoked !== false) throw new Error('Unavailable project');
      const model = data.model ?? p.models[0];
      if (!p.models.includes(model as string)) throw new Error('Model not locally allowed');
      if (s.tasks.length >= 100) throw new Error('MVP task history limit; archive support required before accepting more');
      const t: TaskRecord = { id: text(data.id, 64), projectId: p.id,
        prompt: text(data.prompt, 32_000), model: model as string, status: 'queued', createdAt: now,
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
      const { prompt: _, attempt: __, leaseUntil: ___, createdAt: ____, title: _____, reviewedAt: ______, ...status } = t;
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
    return { task: { ...t, alias: s.projects.find(p => p.id === t.projectId)!.alias } };
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
      const state = await tx.get<CoordinatorState>('state') ?? emptyState();
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
      if (new TextEncoder().encode(JSON.stringify(metadata)).length > 90_000) throw new Error('Metadata storage limit');
      await tx.put('state', metadata);
      return JSON.stringify(result);
    });
  }
}

export async function callCoordinator(env: { PI_COORDINATOR?: DurableObjectNamespace<PiCoordinator> },
  op: string, data: unknown, auth: { owner?: boolean; hash?: string }): Promise<any> {
  if (!env.PI_COORDINATOR) throw new Error('Coordinator unavailable');
  return JSON.parse(await env.PI_COORDINATOR.getByName('owner').command(op, JSON.stringify(data), auth));
}
