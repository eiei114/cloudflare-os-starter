import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const state = `${homedir()}/Library/Application Support/eisuke-os-pi-runner`;
Object.assign(process.env, {
  // Reuse the operator's normal Pi profile, packages, auth, models and session storage.
  PI_CODING_AGENT_DIR: `${homedir()}/.pi/agent`,
  PI_WEB_CONFIG: `${state}/web-config.json`,
  PI_WEB_DATA_DIR: `${state}/web-data`,
  // A short socket path avoids macOS Unix socket path-length limits.
  PI_WEB_SESSIOND_PORT: '47933',
  PI_WEB_SESSIOND_HOST: '127.0.0.1',
  PI_WEB_SESSIOND_URL: 'http://127.0.0.1:47933',
  PI_WEB_HOST: '127.0.0.1',
  PI_WEB_PORT: '8504',
  PI_WEB_SKIP_VERSION_CHECK: '1',
});
// The key already entered in the local setup is an environment fallback only. Never overwrite
// the normal profile's auth.json/settings.json; Pi's native credential precedence still applies.
try {
  const configured = JSON.parse(await readFile(`${state}/cursor-auth.json`, 'utf8'));
  if (!process.env.CURSOR_API_KEY && configured.cursor?.type === 'api_key') {
    process.env.CURSOR_API_KEY = configured.cursor.key;
  }
} catch { /* Other providers keep their normal native authentication. */ }
// No keys in argv, source, plists, logs, or Worker configuration. Pi reads its native auth store.
switch (process.argv[2]) {
  case 'all': {
    const children = ['sessiond', 'web', 'proxy'].map(role => spawn(process.execPath,
      [fileURLToPath(import.meta.url), role], { env: process.env, stdio: 'inherit' }));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      for (const child of children) child.kill('SIGTERM');
      const timer = setTimeout(() => {
        for (const child of children) child.kill('SIGKILL');
        process.exit(1);
      }, 5000);
      timer.unref();
    };
    for (const child of children) {
      child.on('error', stop);
      child.on('exit', stop);
    }
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
    break;
  }
  case 'sessiond': await import(new URL('./node_modules/@jmfederico/pi-web/dist/server/sessiond.js', import.meta.url).href); break;
  case 'web': await import(new URL('./node_modules/@jmfederico/pi-web/dist/server/index.js', import.meta.url).href); break;
  case 'proxy': await (await import('./auth-proxy.mjs')).startProxy(); break;
  default: throw new Error('Expected all, sessiond, web, or proxy role.');
}
