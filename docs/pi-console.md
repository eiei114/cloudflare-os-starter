# Owner-only Pi console (Mac pilot)

This fork adds a **separate human console**, not a replacement model provider in Cloudflare OS
chat. Existing OS chat, Gateway controls, storage and GitHub connection stay unchanged.

```text
Browser → existing OS Access application → Router /gatekeeper/custom/pi/
        → Custom Worker (verified JWT + owner + write/WS Origin checks)
        → HTTPS tunnel → bearer-protected loopback proxy :47931
        → PI WEB :8504 → session daemon :47933 → actual Pi Coding Agent
```

The Mac must be awake, online and running the service. This is not Worker-hosted Pi, a sandbox,
a multi-user service or unattended infrastructure. Only trusted owners and trusted repositories
may use it: Pi tools, terminal, extensions and package management can exercise the Mac user's
filesystem and credentials. `pathAccess` controls browser file access, **not agent confinement**.
Never tunnel ports 8504 or 47933 directly. Keep the service ports bound to loopback.

## Runtime and normal configuration

- Pi Coding Agent 1.1.0; PI WEB 1.202610.1, pinned in `packages/pi-runner/package.json`.
- `run-service.mjs` uses the usual `~/.pi/agent` settings, packages, auth, models and sessions.
  It does not overwrite their defaults or copy their credentials into Cloudflare.
- Add a project explicitly through PI WEB. Its `.pi` resources follow Pi's project-trust check.
  No Vault-wide project or synchronization is automatically enabled.
- The existing global `npm:pi-cursor-sdk` extension supplies Cursor. The already-entered key is
  kept in private `cursor-auth.json` and provided to the service as an environment fallback.
  Existing native Pi auth retains its normal precedence. No key is passed in argv or a plist.
- Other Pi-supported, authenticated providers can be selected; a different CLI's login needs
  a corresponding Pi provider extension. Availability in a catalog is not an inference test.
- Native extensions, skills and supported RPC extension dialogs load. Arbitrary TUI rendering
  is not guaranteed to have an equivalent in this web UI. After changing global provider
  packages, restart the service; use the normal Pi package workflow, not Worker uploads.
- Clicking a model changes the current session only. Its **default star** writes normal Pi
  global defaults; avoid that unless the operator intends a global change.
- Pi/Cursor/Codex costs are independent of the existing OS Gateway's budget and rate limits.
  Cursor SDK uses its documented plan/usage pools; this is not an unlimited subscription bypass.

### Session-owned provider compatibility

Published PI WEB freezes one global provider bootstrap runtime. Cursor's provider closes over
a concrete session's binding and cannot infer through that unbound bootstrap instance. The
`patches/@jmfederico__pi-web@1.202610.1.patch` gives **each hosted session its own ModelRuntime**
before extensions load, using the package's native auth-runtime helper. Siblings cannot replace
each other's stream closure. The shared runtime remains for global auth/catalog UI only.
Do not remove the patch or substitute a newer package version without a two-session isolation
regression test and actual Cursor inference. `provider-isolation.test.mjs` exercises the installed
patched factory with an offline provider and temporary profile, never real auth or model billing.

## Local service files (not tracked)

Under `~/Library/Application Support/eisuke-os-pi-runner/`, keep directory permissions `0700`
and credential files `0600`:

| File | Purpose |
|---|---|
| `cursor-auth.json` | Optional already-provided Cursor API-key fallback; `{cursor:{type:"api_key",key:"…"}}`. |
| `proxy-auth.json` | Independent random bearer token, at least 32 characters; `{token:"…"}`. |
| `web-config.json` | PI WEB host `127.0.0.1`, port `8504`, explicitly registered projects. |
| `web-data/` | PI WEB managed state; not a substitute for normal Pi configuration. |
| `service.log`, `service-error.log` | Private logs; do not publish raw contents. |

The launchd label is `com.eisuke.pi-runner`; plist is
`~/Library/LaunchAgents/com.eisuke.pi-runner.plist`. It runs Node with
`packages/pi-runner/run-service.mjs all`, starting web, sessiond and proxy together. Stop with:

```sh
launchctl bootout gui/$(id -u)/com.eisuke.pi-runner
```

Wait for that label to disappear before bootstrapping again. Keep all child-process environment
and logs private. If another service exists, inspect its ownership rather than stopping it.

## Cloudflare configuration — separate approval required

```jsonc
"customGatekeeper": { "enabled": true, "name": "Eisuke OS", "message": "Personal integrations." },
"piRunner": { "enabled": true, "url": "https://YOUR-BEARER-PROTECTED-TUNNEL-ORIGIN" }
```

`generateConfigs` adds the existing Access issuer/audience/admin emails and OS origin to the
Custom Worker, plus the **required secret name** `PI_RUNNER_TOKEN`. Its value is the separate
Mac proxy token, never a Cursor/model credential. No secret belongs in configuration or Git.
The Custom Worker must remain private (no public/preview routes); the OS Router is its entrance.
Every console HTTP and WS request revalidates the signed, expiring Access JWT and exact owner.
Anonymous tunnel requests are denied independently by the Mac bearer proxy. Forwarded headers
exclude Access JWT/cookies and browser-supplied credentials. HTTP responses disable caching
and drop cookies; upstream redirects stay under the OS console prefix.

Before publishing a tunnel or installing a Worker secret, approve the production mutation
summary required by the operator skill. A Quick Tunnel is only a pilot: its URL changes when
restarted, requiring configuration and redeployment. A durable named tunnel/always-on runner
is a later decision. Do not claim remote use works until signed-owner HTTP/WS, prefix assets,
unauthenticated denial, actual inference and reload persistence have all been verified.

## Verification and rollback

- Offline: `pnpm --filter pi-runner test`, `pnpm --filter custom-gatekeeper test:run`,
  `node --test scripts/deploy.test.ts`, then complete `pnpm check` with Pi enabled.
- Local: normal Codex default visible; select Cursor slow **for the pilot session only**,
  ask a harmless arithmetic question; require answer `5`, Cursor stop reason `stop`, no tool
  calls and persistent transcript under normal Pi session storage. A `$0` UI estimate is not
  evidence of zero Cursor charge.
- Production: exact source commits and all affected Worker versions must be recorded before
  approval. Keep the core submodule pinned; no storage migration is part of this feature.
- Stop the local service/tunnel to revoke Mac reachability immediately. Removing
  `piRunner`/disabling the custom binding and redeploying removes the OS console; coordinate
  rollback per Worker. Do not delete storage or alter Access to fix runtime issues.

References: [PI WEB](https://pi-web.dev),
[Cursor TypeScript SDK](https://cursor.com/docs/api/sdk/typescript),
[pi-cursor-sdk](https://www.npmjs.com/package/pi-cursor-sdk).
