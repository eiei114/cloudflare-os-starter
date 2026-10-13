// Retired: upstream PI WEB exposes unauthenticated execution/auth routes on loopback.
// Keep the entry point fail-closed so old LaunchAgents cannot restart insecure services.
throw new Error('Legacy Pi console disabled for security. Use the Pi daemon task board.');
