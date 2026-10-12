import { describe, expect, it } from 'vitest';
import { RpcStub, RpcTarget, newWorkersWebSocketRpcResponse } from 'capnweb';
import { githubCatalog, repoName } from '../src/github-projects.js';
import { emptyState, transition } from '../src/pi-coordinator.js';

describe('project GitHub association', () => {
  it('validates names and stores a repo-only project without creating execution authority', () => {
    for (const name of ['https://evil.example/repo', 'owner/repo/extra', 'owner/..', 'owner/repo?key=x', 'owner/repo\n'])
      expect(() => repoName(name)).toThrow();
    const s = emptyState();
    transition(s, 'managed-project-save', { id: 'repo-only', workspaceId: 'personal', name: 'Repo', attributes: {},
      github: { accountId: 1, fullName: 'owner/repo', verifiedAt: 1 } }, { owner: true }, 1);
    expect(s.managedProjects?.[0]).toMatchObject({ name: 'Repo', github: { fullName: 'owner/repo', accountId: 1 } });
    expect(s.projects).toHaveLength(0);
    expect(() => transition(s, 'enqueue', { id: 'task', projectId: 'repo-only', prompt: 'run' }, { owner: true }, 2)).toThrow();
  });
  it('reads repositories through the connected owner capability, not a copied token or another account', async () => {
    const seen: { header?: string; query?: string; account?: number } = {};
    class RepoUI extends RpcTarget {
      listRepos(query: string) { seen.query = query; return [{ value: 'owner/repo', title: 'owner/repo', meta: 'private' }]; }
    }
    class Auth extends RpcTarget {
      async subscribeConnectedAccounts(subscriber: any) {
        await subscriber.add(7, { uniqueName: 'owner' }, {}, [{ urlPattern: 'https://github.com/:owner/:repo' }], true, 'github');
        await subscriber.add(8, { uniqueName: 'expired' }, {}, [{ urlPattern: 'https://github.com/:owner/:repo' }], false, 'github');
        await subscriber.ready(); return new RpcStub(new RpcTarget());
      }
      startResourceConfigurator(id: number, pattern: string) {
        seen.account = id; expect(pattern).toBe('https://github.com/:owner/:repo');
        return { iframeHtml: '', ui: new RpcStub(new RepoUI()) };
      }
    }
    class Public extends RpcTarget { authenticateFromCfAccess() { return new RpcStub(new Auth()); } }
    const backend = { fetch: async (request: Request) => {
      seen.header = request.headers.get('cf-access-jwt-assertion') ?? undefined;
      expect(new URL(request.url).pathname).toBe('/api');
      expect(request.headers.get('cookie')).toBeNull();
      return newWorkersWebSocketRpcResponse(request, new Public());
    } } as unknown as Fetcher;
    const req = new Request('https://os.example/runner/github-repos', { headers: { 'cf-access-jwt-assertion': 'already-verified-owner' } });
    const env = { PUBLIC_BASE_URL: 'https://os.example', WORKSHOP_BACKEND: backend };
    const result = await githubCatalog(req, env, { query: 'owner/repo' });
    expect(result).toEqual({ accounts: [{ id: 7, label: 'owner' }], repos: [{ value: 'owner/repo', title: 'owner/repo', meta: 'private' }] });
    expect(seen).toEqual({ header: 'already-verified-owner', query: 'owner/repo', account: 7 });
    seen.account = undefined;
    expect((await githubCatalog(req, env, { accountId: 99, query: '' })).repos).toEqual([]);
    expect(seen.account).toBeUndefined();
  });
});
