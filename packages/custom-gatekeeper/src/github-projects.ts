import { RpcStub, RpcTarget, newWebSocketRpcSession } from 'capnweb';
import type { PublicApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api';
import type { AccountDescription, VendorDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper';

const pattern = 'https://github.com/:owner/:repo';
export type GitHubRepoLink = { accountId: number; fullName: string; verifiedAt: number };
export type RepoOption = { value: string; title: string; subtitle?: string; meta?: string };
export function repoName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(value) || value.split('/')[1] === '.' || value.split('/')[1] === '..')
    throw new Error('Invalid repository');
  return value;
}

/** Read-only use of the existing owner's official GitHub configurator. No OAuth token export. */
export async function githubCatalog(req: Request, env: { PUBLIC_BASE_URL?: string; WORKSHOP_BACKEND?: Fetcher },
  data: Record<string, unknown>): Promise<{ accounts: { id: number; label: string }[]; repos: RepoOption[] }> {
  if (!env.WORKSHOP_BACKEND || !env.PUBLIC_BASE_URL) throw new Error('GitHub catalog unavailable');
  const query = data.query ?? '';
  if (typeof query !== 'string' || query.length > 200 || /[\r\n]/.test(query)) throw new Error('Invalid query');
  const response = await env.WORKSHOP_BACKEND.fetch(new Request(new URL('/api', env.PUBLIC_BASE_URL), {
    headers: { upgrade: 'websocket', 'cf-access-jwt-assertion': req.headers.get('cf-access-jwt-assertion')!,
      origin: env.PUBLIC_BASE_URL },
  }));
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) throw new Error('GitHub session unavailable');
  socket.accept();
  const api = newWebSocketRpcSession<PublicApi>(socket as unknown as globalThis.WebSocket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscription: RpcStub<{}> | undefined;
  const operation = async () => {
    const auth = await api.authenticateFromCfAccess();
    const accounts: { id: number; label: string }[] = [];
    let ready!: () => void; const available = new Promise<void>(resolve => { ready = resolve; });
    class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
      add(id: number, description: AccountDescription, _vendor: VendorDescription,
        resources: SupportedResource[], valid: boolean, vendorId: string) {
        if (vendorId === 'github' && valid && resources.some(r => r.urlPattern === pattern))
          accounts.push({ id, label: description.uniqueName || description.displayName || 'GitHub' });
      }
      remove(id: number) { const index = accounts.findIndex(a => a.id === id); if (index >= 0) accounts.splice(index, 1); }
      ready() { ready(); }
    }
    subscription = await auth.subscribeConnectedAccounts(new RpcStub(new Subscriber()), { resourceUrl: 'https://github.com/owner/repo' });
    await available;
    // Multiple accounts require explicit choice. Never silently use another identity.
    const account = data.accountId === undefined && accounts.length === 1 ? accounts[0] : accounts.find(a => a.id === data.accountId);
    if (!account) return { accounts, repos: [] };
    const frame = await auth.startResourceConfigurator(account.id, pattern);
    const ui = frame.ui as unknown as RpcStub<{ listRepos(query: string): Promise<RepoOption[]> }>;
    const repos = await ui.listRepos(query);
    return { accounts, repos: repos.slice(0, 100).map(r => ({ value: repoName(r.value), title: r.title.slice(0, 200),
      ...(r.subtitle ? { subtitle: r.subtitle.slice(0, 1000) } : {}), ...(r.meta ? { meta: r.meta.slice(0, 30) } : {}) })) };
  };
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('GitHub catalog timeout')), 15_000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    subscription?.[Symbol.dispose](); api[Symbol.dispose](); socket.close(1000, 'Catalog finished');
  }
}
