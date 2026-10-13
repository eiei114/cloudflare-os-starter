import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        durableObjects: { PI_COORDINATOR: { className: 'PiCoordinator', useSQLite: true },
          PI_PROJECT_GATEKEEPER: { className: 'PiProjectGatekeeper', useSQLite: true },
          PI_TEST_PARENT: { className: 'PiTestParent', useSQLite: true } },
        bindings: { PI_DAEMON_ENABLED: true },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
