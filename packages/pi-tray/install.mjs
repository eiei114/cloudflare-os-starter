import { mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const run = (exe, args) => { const r = spawnSync(exe, args, { cwd: here, stdio: 'inherit', shell: false }); if (r.status !== 0) throw Error('Tray installation failed'); };
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const quote = s => `'${s.replaceAll("'", "''")}'`;
if (!['darwin', 'win32'].includes(process.platform)) throw Error('Mac/Windows installer only');
const state = process.platform === 'darwin' ? path.join(homedir(), 'Library/Application Support/eisuke-os-pi-daemon')
  : path.join(process.env.LOCALAPPDATA, 'CloudflareOSPiDaemon');
await access(path.join(state, 'config.json')); // Pair/install the daemon first. No credential reads.
run('cargo', ['build', '--release', '--locked']);
if (process.platform === 'darwin') {
  const app = path.join(homedir(), 'Applications/Cloudflare OS Pi.app');
  // Refuse overwrite/racing a running installation. Updating needs an explicit uninstall/quit.
  const contents = path.join(app, 'Contents'); await mkdir(path.dirname(app), { recursive: true });
  await mkdir(app); await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await copyFile(path.join(here, 'target/release/cloudflare-os-tray'), path.join(contents, 'MacOS/cloudflare-os-tray'));
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.eisuke.pi-tray</string><key>CFBundleName</key><string>Cloudflare OS Pi</string>
<key>CFBundleExecutable</key><string>cloudflare-os-tray</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string><key>LSUIElement</key><true/></dict></plist>`);
  run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  // Place our own new item near the system controls, not beneath a crowded Mac notch.
  // AppKit subsequently preserves the user's Command-dragged position under this name.
  run('/usr/bin/defaults', ['write', 'com.eisuke.pi-tray', 'NSStatusItem Preferred Position com.eisuke.pi-tray.status', '-int', '220']);
  const agents = path.join(homedir(), 'Library/LaunchAgents'); await mkdir(agents, { recursive: true });
  const plist = path.join(agents, 'com.eisuke.pi-tray.plist');
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>Label</key><string>com.eisuke.pi-tray</string><key>ProgramArguments</key><array><string>${xml(path.join(contents, 'MacOS/cloudflare-os-tray'))}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>StandardErrorPath</key><string>${xml(path.join(state, 'tray-error.log'))}</string></dict></plist>`, { flag: 'wx', mode: 0o600 });
  run('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
  console.log(`Installed ${app}. Tray starts at login; quitting it does not stop Pi.`);
} else {
  const dest = path.join(process.env.LOCALAPPDATA, 'Programs/CloudflareOSPiControl'); await mkdir(dest, { recursive: true });
  const exe = path.join(dest, 'cloudflare-os-tray.exe'); await copyFile(path.join(here, 'target/release/cloudflare-os-tray.exe'), exe);
  const code = `$ErrorActionPreference='Stop';$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name;
$a=New-ScheduledTaskAction -Execute ${quote(exe)};$t=New-ScheduledTaskTrigger -AtLogOn -User $user;
$p=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero);
Register-ScheduledTask -TaskName 'com.eisuke.pi-tray' -Action $a -Trigger $t -Principal $p -Settings $s | Out-Null;
Start-ScheduledTask -TaskName 'com.eisuke.pi-tray';`;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code]);
  console.log(`Installed ${exe}. Tray starts at login; quitting it does not stop Pi.`);
}
