import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stateDirectory, protectDirectory, writePrivate } from './daemon.mjs';

const label = 'com.eisuke.pi-daemon';
const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const ps = s => `'${s.replaceAll("'", "''")}'`;
const run = (exe, args) => { const r = spawnSync(exe, args, { stdio: 'inherit', shell: false }); if (r.status !== 0) throw new Error('Service operation failed'); };
export function macPlist(node, script, dir) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>run</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>${xml(path.join(dir, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(dir, 'service-error.log'))}</string>
</dict></plist>`;
}
export function windowsInstall(node, script) {
  if ([node, script].some(s => /["\r\n]/.test(s))) throw new Error('Unsafe executable path');
  return `$ErrorActionPreference='Stop'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name;
$action=New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(`"${script}" run`)};
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user;
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable;
Register-ScheduledTask -TaskName ${ps(label)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null;`;
}
async function main() {
  const op = process.argv[2]; const dir = stateDirectory(); await protectDirectory(dir);
  const script = fileURLToPath(new URL('./daemon.mjs', import.meta.url));
  if (op === 'stop') {
    await writePrivate(path.join(dir, 'stop.request'), {});
    console.log('Stop requested. Wait for daemon.lock to disappear; do not delete an active receipt.'); return;
  }
  if (!['install', 'start', 'status'].includes(op)) throw new Error('Usage: node install.mjs install|start|stop|status');
  if (op === 'start') await unlink(path.join(dir, 'stop.request')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    if (op === 'install') {
      const parent = path.join(homedir(), 'Library', 'LaunchAgents'); await mkdir(parent, { recursive: true });
      const file = path.join(parent, `${label}.plist`);
      await writeFile(file, macPlist(process.execPath, script, dir), { flag: 'wx', mode: 0o600 });
      run('launchctl', ['bootstrap', domain, file]);
    } else run('launchctl', [op === 'status' ? 'print' : 'kickstart', `${domain}/${label}`]);
  } else if (process.platform === 'win32') {
    const code = op === 'install' ? windowsInstall(process.execPath, script)
      : `${op === 'start' ? 'Start-ScheduledTask' : 'Get-ScheduledTaskInfo'} -TaskName ${ps(label)}`;
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code]);
  } else throw new Error('Service installer supports macOS/Windows; run manually on Linux');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Service operation failed; existing services were not replaced.'); process.exitCode = 1;
});
