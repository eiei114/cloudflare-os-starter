export * from "./custom.js";
import { fetchPiConsole, type PiConsoleEnv } from './pi-console.js';

export default {
  async fetch(request: Request, env: PiConsoleEnv): Promise<Response> {
    const consoleResponse = await fetchPiConsole(request, env);
    if (consoleResponse) return consoleResponse;
    return new Response("Custom Gatekeeper worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
