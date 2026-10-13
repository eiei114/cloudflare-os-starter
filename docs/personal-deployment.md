# Personal deployment ownership

This fork is the deployment wrapper. Its `cloudflare-os` submodule resolves from
`eiei114/cloudflare-os` and is pinned to the existing hosted release's source commit,
`34e0a99a87929c8b54b6fb4bf8d15c828c492baa` (`r002717-34e0a99`). The first takeover
does not adopt the newer public branch head or change Durable Object migrations.

## Local configuration

`pnpm check` and `pnpm deploy` prefer **gitignored** `deployment.local.jsonc` when it
exists, otherwise they use `deployment.jsonc`. Keep account-specific configuration
local; never add credentials to either file. Wrangler OAuth credentials belong in
the OS keychain, not this repository.

For a fresh machine, reconstruct the local configuration from your private
operation record and verify it against the live account. Do not deploy the generic
template over an existing installation. See [hosted migration](migrate-from-hosted.md).

## Retain installed connectors

The optional `existingGatekeepers` array retains Workers that are already installed:

```json
"existingGatekeepers": [{ "id": "github", "service": "your-existing-github-worker" }]
```

The generator binds each vendor to both Workshop RPC (`GatekeeperVendor`) and router
HTTP (`/gatekeeper/<id>`). It does **not** deploy, delete, or update that Worker's
credentials. Check its pinned release's compatibility before a future kernel upgrade.
GitHub account capabilities and OAuth tokens remain in the existing GitHub Worker's
Durable Objects. Do not recreate the Worker under a different name.

Set `customGatekeeper.enabled` to `false` to omit the example custom integration from
build/deploy and service bindings. The default remains enabled for compatibility.
The personal takeover disables this example and the Error Reporter: no new Workers
or storage resources are necessary.

## Gradual updates

1. Make a bounded change in the core fork or a wrapper-owned integration.
2. Run the relevant tests. Commit and push the core change before updating its gitlink.
3. Review the source pin, resource identities, credentials, and migration compatibility.
4. Run `pnpm lint` and `pnpm check` in this wrapper.
5. Approve the mutation and rollback summary, then run `pnpm deploy` once.
6. Verify Access, existing conversations, GitHub accounts, model settings, and cost controls.

Keep the hosted wizard closed after takeover; it is no longer the deployment source
of truth. Preserve prior Worker version IDs, but do not assume a code rollback
restores storage, Access policies, or other account resources.
