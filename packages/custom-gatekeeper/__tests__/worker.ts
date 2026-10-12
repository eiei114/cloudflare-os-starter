export { default } from "../src/index.js";
export * from "../src/index.js";
export { PiCoordinator } from '../src/pi-coordinator.js';
export { PiProjectGatekeeper } from '../src/pi-project.js';
import { DurableObject, RpcTarget, type RpcStub } from 'cloudflare:workers';
import type { ApprovalQueue } from '@gadgets/workshop-shared/gatekeeper';
import type { PiProjectGatekeeper } from '../src/pi-project.js';

class TestQueue extends RpcTarget {
  async authorizeObservation(_description: unknown) {}
  async submitAction(_id: number, _description: unknown) {}
}
export class PiTestParent extends DurableObject {
  async scenario(projectId: string, mode: string): Promise<string> {
    const facet = this.ctx.facets.get<PiProjectGatekeeper>('project', () => ({
      class: this.ctx.exports.PiProjectGatekeeper({ props: { projectId } }),
    }));
    const queue = new TestQueue() as unknown as RpcStub<ApprovalQueue>;
    const project = await facet.startSession(queue);
    const task = await project.submitTask({ prompt: 'safe test prompt' });
    const before = await task.getStatus();
    if (mode === 'cancel-first') { await task.cancel(); await facet.applyAction(2, queue as any); await facet.applyAction(1, queue as any); }
    else if (mode === 'reject') await facet.rejectAction(1);
    else { await facet.applyAction(1, queue as any); await facet.applyAction(1, queue as any); }
    const after = await task.getStatus();
    let observerDenied = false;
    try { await facet.addObserver('stranger', queue as any); } catch (e) { observerDenied = String(e).includes('cannot be shared'); }
    return JSON.stringify({ before, after, observerDenied });
  }
}
