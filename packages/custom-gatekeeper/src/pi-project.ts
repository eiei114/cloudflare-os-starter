import { DurableObject, RpcTarget, type RpcStub } from 'cloudflare:workers';
import { validateRpc } from 'capnweb-validate';
import type { ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper';
import type { PiProject, PiTask, ProjectStatus, TaskStatus } from './types.js';
import TYPES_CODE from './types-code.js';
import { callCoordinator, type TaskRecord } from './pi-coordinator.js';

export const PI_PROJECT_RESOURCE: SupportedResource = {
  urlPattern: 'pi-project://projects/:projectId', title: 'Local Pi project',
  description: 'Run tasks using a paired device and its locally approved Pi models. Owner-only; not a sandbox.',
};
type Props = { projectId: string };
type Action = { kind: 'submit'; task: TaskRecord } | { kind: 'cancel'; id: string };

@validateRpc()
export class PiTaskImpl extends RpcTarget implements PiTask {
  constructor(private gatekeeper: PiProjectGatekeeper, private queue: RpcStub<ApprovalQueue>, private id: string) { super(); }
  async getStatus(): Promise<TaskStatus> {
    await this.queue.authorizeObservation({ title: 'Read Pi task', description: 'Read task progress and final answer.', containsRestrictedData: true });
    return this.gatekeeper.taskStatus(this.id);
  }
  async cancel(): Promise<void> { await this.gatekeeper.stage({ kind: 'cancel', id: this.id }, this.queue); }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

@validateRpc()
export class PiProjectImpl extends RpcTarget implements PiProject {
  constructor(private gatekeeper: PiProjectGatekeeper, private queue: RpcStub<ApprovalQueue>) { super(); }
  async getStatus(): Promise<ProjectStatus> {
    await this.queue.authorizeObservation({ title: 'Read Pi project', description: 'Read paired project availability and allowed models.', containsRestrictedData: true });
    const p = await this.gatekeeper.project();
    return { id: p.id, alias: p.alias, models: p.models, deviceStatus: p.deviceStatus, lastSeen: p.lastSeen };
  }
  async submitTask(input: { prompt: string; model?: string }): Promise<PiTask> {
    const p = await this.gatekeeper.project();
    const model = input.model ?? p.models[0];
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || new TextEncoder().encode(input.prompt).length > 32_000 || !p.models.includes(model)) throw new Error('Invalid task or model');
    const task: TaskRecord = { id: crypto.randomUUID(), projectId: p.id, model, prompt: input.prompt, status: 'queued' };
    await this.gatekeeper.stage({ kind: 'submit', task }, this.queue);
    return new PiTaskImpl(this.gatekeeper, this.queue.dup(), task.id);
  }
  async getTask(id: string): Promise<PiTask> {
    await this.queue.authorizeObservation({ title: 'Read Pi task', description: 'Locate a task in this project.', containsRestrictedData: true });
    await this.gatekeeper.taskStatus(id);
    return new PiTaskImpl(this.gatekeeper, this.queue.dup(), id);
  }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

/** Project-scoped facet; only approval applyAction may deliver side effects to the coordinator. */
@validateRpc()
export class PiProjectGatekeeper extends DurableObject<Cloudflare.Env, Props> implements Gatekeeper<PiProject> {
  private async command(op: string, data: unknown): Promise<any> {
    if (!this.env.PI_DAEMON_ENABLED || !this.env.PI_COORDINATOR) throw new Error('Pi daemon disabled');
    return callCoordinator(this.env, op, data, { owner: true });
  }
  async project(): Promise<ProjectStatus> {
    const p = await this.command('project', { projectId: this.ctx.props.projectId });
    if (!p) throw new Error('Unknown project');
    return p;
  }
  async describe(): Promise<ResourceDescription> {
    const p = await this.project();
    return { url: `pi-project://projects/${p.id}`, title: `Pi: ${p.alias}`, snippet: PI_PROJECT_RESOURCE.description,
      suggestedBindingName: 'PI_PROJECT', tsType: 'PiProject' };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<PiProject> { await this.project(); return new PiProjectImpl(this, queue.dup()); }
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> { throw new Error('Local Pi projects cannot be shared'); }
  async removeObserver(_id: string): Promise<void> {}
  async revertAction(_id: number): Promise<void> { throw new Error('Pi task side effects cannot be reverted'); }
  async stage(action: Action, queue: RpcStub<ApprovalQueue>): Promise<void> {
    if (action.kind === 'cancel') await this.taskStatus(action.id);
    const id = await this.ctx.storage.transaction(async tx => {
      const sequence = (await tx.get<number>('sequence') ?? 0) + 1;
      await tx.put('sequence', sequence); await tx.put(`action:${sequence}`, action); return sequence;
    });
    try {
      await queue.submitAction(id, {
        title: action.kind === 'submit' ? 'Run local Pi task' : 'Cancel local Pi task',
        description: 'Pi uses this device’s normal credentials, extensions, filesystem, network and external service authority. Model calls may incur costs. Prompt and final answer are stored in Cloudflare. Not a sandbox. Cancellation does not undo side effects.',
        descriptionIsComplete: true,
        implementsRevert: false,
        fields: action.kind === 'submit' ? [
          { kind: 'inline', label: 'Project', value: this.ctx.props.projectId },
          { kind: 'inline', label: 'Model', value: action.task.model },
          { kind: 'text', label: 'Prompt', value: action.task.prompt },
        ] : [{ kind: 'inline', label: 'Task', value: action.id }],
      });
    } catch (error) { await this.ctx.storage.delete(`action:${id}`); throw error; }
  }
  async taskStatus(id: string): Promise<TaskStatus> {
    let status: TaskStatus | undefined;
    try { status = await this.command('task', { projectId: this.ctx.props.projectId, id }); }
    catch { /* A task may still be simulated, waiting for action application. */ }
    const actions = await this.ctx.storage.list<Action>({ prefix: 'action:' });
    for (const action of actions.values()) if (action.kind === 'submit' && action.task.id === id && !status)
      status = { id, projectId: this.ctx.props.projectId, model: action.task.model, status: 'pending' };
    status ??= await this.ctx.storage.get<TaskStatus>(`terminal:${id}`);
    if (!status) throw new Error('Unknown task');
    if (await this.ctx.storage.get(`cancelled:${id}`)) status = { ...status, status: 'cancelled' };
    if ([...actions.values()].some(a => a.kind === 'cancel' && a.id === id)) status = { ...status, status: 'cancel-requested' };
    return status;
  }
  async applyAction(id: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
    const action = await this.ctx.storage.get<Action>(`action:${id}`);
    if (!action) return;
    if (action.kind === 'submit') {
      if (await this.ctx.storage.get(`cancelled:${action.task.id}`)) {
        await this.ctx.storage.put(`terminal:${action.task.id}`, { id: action.task.id, projectId: action.task.projectId,
          model: action.task.model, status: 'cancelled' } satisfies TaskStatus);
      } else await this.command('enqueue', action.task);
    } else {
      const actions = await this.ctx.storage.list<Action>({ prefix: 'action:' });
      const pending = [...actions.values()].find(a => a.kind === 'submit' && a.task.id === action.id);
      if (pending) await this.ctx.storage.put(`cancelled:${action.id}`, true);
      // Enqueue might have succeeded before an apply retry. Cancel it as well, if present.
      if (await this.command('task', { projectId: this.ctx.props.projectId, id: action.id }))
        await this.command('cancel', { projectId: this.ctx.props.projectId, id: action.id });
      else if (!pending) throw new Error('Unknown task');
    }
    await this.ctx.storage.delete(`action:${id}`);
    });
  }
  async rejectAction(id: number): Promise<void> {
    const action = await this.ctx.storage.get<Action>(`action:${id}`);
    if (action?.kind === 'submit') await this.ctx.storage.put(`terminal:${action.task.id}`, {
      id: action.task.id, projectId: action.task.projectId, model: action.task.model, status: 'cancelled',
    } satisfies TaskStatus);
    await this.ctx.storage.delete(`action:${id}`);
  }
}
