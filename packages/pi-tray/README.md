# Cloudflare OS Pi tray control

Minimal Rust tray utility: `tray-icon` / its native `muda` menus / `tao` event loop.
No WebView, inference engine, HTTP listener, cloud credentials, embedded Node runtime or generic shell endpoint.
Requires the paired/installed Pi daemon on this computer. Does not provision a new PC from a URL.

## Build / install

```sh
cargo test --manifest-path packages/pi-tray/Cargo.toml --locked
cargo clippy --manifest-path packages/pi-tray/Cargo.toml --locked -- -D warnings
node packages/pi-tray/install.mjs
```

Rust stable and the platform compiler toolchain are required to build. The Mac installer creates
`~/Applications/Cloudflare OS Pi.app`, locally ad-hoc signs it and registers `com.eisuke.pi-tray`
as a login LaunchAgent. This is not a notarized public distribution. Windows builds natively,
copies the executable under LOCALAPPDATA/Programs and registers an interactive limited-user login task.
No daemon service/credential migration occurs. Mac install refuses an existing app/plist rather than overwriting it.
The Mac menu bar item is a dot labelled `Pi`. Initial placement is near system controls to avoid
a crowded display notch; Command-drag can change its saved position. Green means recent contact.

Menu: status, start, cooperative stop, restart, daemon login-autostart checkbox, task board, service log, quit UI.
UI logout/quit never kills the daemon. The tray itself starts at login; its checkbox controls the **daemon**,
not the tray process. macOS uses launchctl enable/disable; Windows uses Scheduled Task enable/disable.
Manual start temporarily enables a disabled daemon service and restores the user's disabled preference afterwards.
Windows task disabling also disables its other configured triggers; the supported daemon task has only a login trigger.

`runtime-status.json` contains only schema version, daemon PID, phase, last successful server contact time and OS origin.
It is generated privately by the updated daemon (0600 on POSIX, inherited private ACL on Windows).
The tray does not read config/auth files or contact Cloudflare. Green means contact within 45 seconds with matching
status/lock PID; it is a recent-contact indicator, not a guarantee of future connectivity. Old daemons show unknown status.
Restart waits up to 20 seconds for lock removal, then refuses interrupted receipts. Never clears receipts/locks or
forces an uncertain execution to replay. PC sleep/shutdown still stops cloud execution.

Diagnostics: `cloudflare-os-tray --status`, `--start`, `--stop`, `--restart`, `--autostart-on`, `--autostart-off`.
Only these fixed local actions exist. UI is single-instance via an OS-held file lock. Close/relaunch releases it normally.
To uninstall the Mac UI: quit it, bootout `gui/<uid>/com.eisuke.pi-tray`, then remove its plist and app bundle.
On Windows unregister only `com.eisuke.pi-tray` and remove its installed executable. Leave daemon state and its task intact.
