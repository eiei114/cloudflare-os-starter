# Outbound Pi daemon MVP

Implementation only. **Not deployed, paired, or installed as a service. Windows native execution remains untested.** The existing Mac human console and Multica installation are unchanged.

## Reference and scope

Reference: Multica v0.6.1, commit `2ea01ae4ef55de4310b99af192d2dbd367832883`.

- [`server/internal/handler/daemon.go`](https://github.com/multica-ai/multica/blob/2ea01ae4ef55de4310b99af192d2dbd367832883/server/internal/handler/daemon.go): device/runtime ownership, heartbeat, bounded claim, completion and cancellation acknowledgement.
- [`server/internal/daemon/daemon.go`](https://github.com/multica-ai/multica/blob/2ea01ae4ef55de4310b99af192d2dbd367832883/server/internal/daemon/daemon.go): outbound acquisition, local CLI execution, cancellation polling, durable terminal-report outbox (`reportTerminalTask`).

This is an independent implementation of those lifecycle concepts, **not a copy, fork or redistribution of Multica source/UI**. Multica's license includes additional conditions; do not transplant its code/UI without reviewing them. No live Multica API, runtime, agent, queue, project or schedule was modified.

Included: pairing/revocation, project registration, outbound HTTP polling, one in-flight job per device, fenced 45-second leases, bounded progress, final report, cooperative cancellation and durable receipt/outbox. Unlike broader Multica recovery, an unknown attempt is never automatically reassigned/re-executed. An uncertain task quarantines its device from further claims.

Included owner task management: creation with explicit approval, bounded task list, stage/status polling, selected final answer, and cancellation request at `/gatekeeper/custom/runner/`. Cloudflare OS owns the queue and task lifecycle; the daemon only executes. Owner UI submissions are marked `owner-ui`, agent-approved submissions `os-approval`. This is a first task-management slice, not a full Multica issue tracker.

Excluded: issue hierarchy, squads, repo cloning/worktrees, WebSocket wakeups, updater, credential synchronization, generic shell API, sandbox, recovery/archival UI and multi-user hosting. MVP caps: 20 devices total, 20 projects total and 100 retained tasks. Exhausting a limit fails closed; archival is a later implementation, not an existing command.

## Flow and authority

```text
Cloudflare OS project capability
    -> submitAction (full prompt/model/project displayed)
    -> applyAction after OS approval
    -> private PiCoordinator DO queue
    <- outbound device heartbeat / claim
    -> dedicated native Pi CLI RPC process in trusted local project
    <- stage / final report or cancellation acknowledgement
```

The daemon uses Pi Coding Agent 1.1.0's public CLI/RPC protocol, not another Pi core patch. The registered model is selected after extension loading via `set_model` (non-persistent); a missing provider fails before prompting. Native Pi loads the computer's normal profile, auth, packages and trusted project's resources. Nothing imports Mac credentials into Windows. A provider extension must already be installed/authenticated on **each execution computer**. Cursor is used through the local Cursor provider extension, not an OpenAI API compatibility shim. The OS's own chat/orchestration model remains unchanged and can still incur its existing cloud inference charges.

Remote requests cannot choose an absolute cwd, arbitrary argv, shell command, environment variables or model outside the local allowlist. Absolute paths stay local. **A project cwd is not a sandbox**: Pi and trusted extensions retain the user's filesystem/network/external-service permissions. Model calls can incur provider charges. Prompts and final answers are stored in Cloudflare; private files can appear in answers if requested. Do not treat this as a credential-exfiltration prevention layer.

The public agent API is one `PiProject` with `getStatus`, `submitTask`, `getTask`, and task `getStatus`/`cancel`. Every observation is authorized before return. Restricted observations suspend automatic approvals and sharing; `addObserver` always rejects. Execution and cancellation are staged through OS ApprovalQueue, not performed during submission. Rejected execution never becomes claimable; approving cancellation before execution prevents later enqueue. Repeated action application and identical completion delivery are idempotent. Cancellation does not reverse completed side effects.

The human owner portal is a separate authenticated approval surface. `submit` requires the verified owner JWT, the canonical browser Origin, JSON and `approved: true`. The portal shows project/model/prompt and local authority before confirmation. It retains a submission ID across unchanged retries. It never allows devices to submit work. The task list omits prompt, answer, attempt and lease credentials; results are read only after selecting a task. User data is rendered through `textContent`, not HTML. Owner operations are not part of the agent capability API.

**Single-owner private deployment only**: enabling requires one administrator; the Access policy must also admit only that owner (plus the narrowly approved daemon service identity). The credential-free Custom account does not provide tenant isolation. Do not enable this MVP on a public/multi-member OS deployment. Project lookup is through the opaque `pi-project://projects/<uuid>` URL copied from the owner portal; a resource picker is not included.

## Deployment gate — not performed

Enable only after a separate production mutation review:

```jsonc
"piDaemon": { "enabled": true }
```

This adds `PI_COORDINATOR` and migration `pi-daemon-v1` for `PiCoordinator` / `PiProjectGatekeeper` in the existing private Custom Worker. Old `CustomGatekeeper`, existing KV/R2 and GitHub connection remain unchanged. Disabled/default configurations emit no daemon binding or migration.

Device requests do **not** magically pass the existing interactive Cloudflare Access policy. They use only `/gatekeeper/custom/runner/device/*`; the owner portal, task management, pairing-code creation and revocation remain outside that path, under the original owner Access application/audience. The old unprefixed device endpoints return 404.

Production transport plan: one additional path-specific self-hosted Access application, with a **Service Auth** policy admitting only the dedicated daemon service token. More-specific Access applications do not inherit the root application policy. Do not attach the token to the whole OS app, use Bypass/Everyone, or change the original audience/admin policy. The client sends local `accessClientId` / `accessClientSecret` on every request; these are separate from the device bearer. New Access service secrets may use the `cfast_` format; do not require legacy hexadecimal format. **No Access policy/service token has been created. Do not put service credentials in the repository.** Keep the private Custom Worker workers.dev and preview routes disabled.

Before rollout: review exact commits, Worker identities, migrations, owner/Access policy, credential scope, costs, data retention and rollback. A rollback of code does not undo created DO storage or local Pi effects. Stop/revoke all devices before rolling back; preserve receipts and DO data. No secret installation, production migration, pairing or daemon startup occurred here.

## One-time local setup (after rollout approval)

Node >=24.19 and repository-pinned pnpm 11.17; same checkout/package on the native Mac or Windows host:

```sh
pnpm install --frozen-lockfile
node packages/pi-daemon/daemon.mjs init
```

Edit the printed **private local** `config.json`. Empty projects fail closed. Use one trusted project initially:

```json
{
  "url": "https://your-os.example.com",
  "projects": [
    { "alias": "my-project", "cwd": "/absolute/trusted/project", "models": ["cursor/your-registered-model"] }
  ]
}
```

Windows uses e.g. `"cwd": "C:\\Users\\you\\Projects\\my-project"`, not a copied Mac path. Use exact models advertised by that computer's Pi installation. Changing an existing alias's model list requires revocation/new pairing; removed aliases are refused by local execution rather than silently retargeted.

An explicitly trusted local `cursorAuthFile` may supply the old pilot's `{ "cursor": { "type": "api_key", "key": "..." } }` fallback to the child environment if no `CURSOR_API_KEY` is already set. This option is never auto-enabled; normal native Pi auth precedence still applies. Keep the file private and outside git. No provider key goes in pairing, Worker vars, argv, service definitions or progress logs.

After approved deployment, open `/gatekeeper/custom/runner/` in the owner's normal logged-in browser. Create a device-labelled five-minute one-use code, then enter it in a **private terminal**, never chat or command arguments:

```sh
node packages/pi-daemon/daemon.mjs pair
node packages/pi-daemon/daemon.mjs run
```

The portal validates signed Access JWT issuer/audience/expiry/email and canonical Origin for writes. Device routes reject browser cookies/Origin and require a separate bearer. Pairing consumes a 256-bit one-use code; only token hashes are stored remotely. Device authentication cannot submit jobs or revoke devices. A service JWT without owner email cannot operate the owner portal. The daemon publishes alias/model metadata and prints opaque project URLs, not absolute paths, prompts, results or credentials.

## Login startup and stop

First confirm foreground execution; then optionally install under the same user:

```sh
node packages/pi-daemon/install.mjs install
node packages/pi-daemon/install.mjs status
node packages/pi-daemon/install.mjs stop
node packages/pi-daemon/install.mjs start
```

- macOS: separate LaunchAgent `com.eisuke.pi-daemon`, RunAtLoad; no overwrite of existing services and no KeepAlive restart storm.
- Windows: user logon Scheduled Task, Interactive / Limited, no SYSTEM/elevation; quoted executable/path arguments without a shell.
- State: Mac `~/Library/Application Support/eisuke-os-pi-daemon`; Windows `%LOCALAPPDATA%\\CloudflareOSPiDaemon`. POSIX parent 0700/files 0600; Windows state directory has a current-user DACL with inheritance removed. Native Windows ACL/scheduler behavior remains a rollout verification item.
- `stop` writes a private stop request. The loop acknowledges it (normally within a heartbeat cycle, possibly longer during a network timeout), aborts its own Pi RPC process, and releases its lock. It is not a global process killer. Wait for `daemon.lock` to disappear. Foreground Ctrl-C/SIGTERM uses the same stop path. `start` clears the stop request.
- Uninstall after confirmed stop: macOS `launchctl bootout gui/<uid>/com.eisuke.pi-daemon` then remove only its plist; Windows unregister only the `com.eisuke.pi-daemon` Scheduled Task. Preserve private state/session/receipts for inspection. Never touch old Pi/Multica services.

## Failure semantics

- `agent_end` is **not** completion; wait for Pi `agent_settled` and confirmed final assistant stop reason.
- Only stage names travel as progress. Provider errors/tool arguments/stdout/stderr are not exported as progress logs. Final answer is UTF-8 bounded (~32KB); prompt limit 32KB; each task has its own bounded DO KV record rather than a single oversized history value.
- Abort requests wait for settlement. Forced stop or unexplained exit is `uncertain`, not confirmed cancellation. It cannot undo already executed local/network changes.
- Successful heartbeat renews a 45-second server lease. A separate local timer initiates stop ~35 seconds from request start; grace is five seconds. Suspension/network ambiguity still requires local inspection; this is not exactly-once side-effect execution.
- Journal a receipt **before** spawning Pi. A crash/stale lock never auto-clears or replays execution. On restart, an unfinished receipt blocks operation. Inspect the actual process/session/side effects first; do not merely delete the lock.
- Persist the exact terminal report before delivery. Replay only that report after restart; delete it only after server acknowledgement. Late or changed reports cannot overwrite a terminal/expired attempt. If the cloud lease has expired, keep the outbox and inspect locally rather than rerunning.
- Revocation fences the token immediately; active tasks become uncertain. The disconnected/revoked computer stops when renewal fails; revocation is not proof that it has already stopped.

## Verification

Automated: deployment-config opt-in/noninterference test; real workerd DO/facet approval simulation, reject/cancel-first, idempotent apply, observer rejection, atomic concurrent claim, JWT owner/audience, one-use pairing, device separation, lease expiry/fencing, revocation, bounds and cross-project reads. Owner UI tests include explicit approval, allowed models, foreign Origin rejection, idempotent submission, cancellation, list redaction, emitted-script syntax and email-less service JWT rejection. Node tests cover native subprocess pipes against a no-model fixture, fake Pi settlement/errors/abort, Windows path/startup generation, private receipt persistence, blocked replay, terminal outbox and journal-before-execution.

Current Cloudflare references: [application path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [Worker rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

`pnpm check` runs the full tests/builds and Wrangler dry-runs with daemon enabled in ignored local configuration. `pnpm lint:check` and TypeScript checks also run. This does **not** verify real Cursor inference, Windows SDK/runtime/ACL/Scheduled Tasks, native extension prompts, production Access transport or end-to-end OS agent execution. No paid model probe was performed for this MVP.
