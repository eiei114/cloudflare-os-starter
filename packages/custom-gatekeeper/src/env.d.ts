declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "CustomGatekeeper" | "PiCoordinator" | "PiProjectGatekeeper";
  }
  interface Env {
    PI_DAEMON_ENABLED?: boolean;
    PI_COORDINATOR?: DurableObjectNamespace<import('./pi-coordinator.js').PiCoordinator>;
  }
}
