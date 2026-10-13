export * from "./custom.js";
export { PiCoordinator } from './pi-coordinator.js';
export { PiProjectGatekeeper } from './pi-project.js';
import { fetchPiDaemon, type DaemonEnv } from './pi-daemon-http.js';
import { fetchPiConsole, type PiConsoleEnv } from './pi-console.js';

export default {
  async fetch(request: Request, env: PiConsoleEnv & DaemonEnv): Promise<Response> {
    const daemonResponse = await fetchPiDaemon(request, env);
    if (daemonResponse) return daemonResponse;
    const consoleResponse = await fetchPiConsole(request, env);
    if (consoleResponse) return consoleResponse;
    return new Response("Custom Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
