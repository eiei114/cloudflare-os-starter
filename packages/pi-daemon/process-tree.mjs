import { spawnSync } from 'node:child_process';

// Track process identities, not PIDs alone. Covers detached shells observed before reparenting.
// Arbitrary native code can double-fork between scans: this is containment, not an OS sandbox.
export function trackProcessTree(pid) {
  const owned = new Map(); let inspectionFailed = false;
  function snapshot() {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 1000 });
    if (r.status !== 0) { inspectionFailed = true; return []; }
    return r.stdout.trim().split('\n').map(line => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return m ? { pid: Number(m[1]), parent: Number(m[2]), stamp: m[3] } : undefined;
    }).filter(Boolean);
  }
  function collect(rows) {
    const root = rows.find(p => p.pid === pid);
    if (root && !owned.has(pid)) owned.set(pid, root.stamp);
    let changed;
    do {
      changed = false;
      for (const p of rows) if (owned.has(p.parent) && !owned.has(p.pid)) {
        const parent = rows.find(v => v.pid === p.parent);
        if (parent?.stamp === owned.get(p.parent)) { owned.set(p.pid, p.stamp); changed = true; }
      }
    } while (changed);
  }
  const scan = () => { const rows = snapshot(); collect(rows); return rows; };
  scan(); const timer = setInterval(scan, 50);
  return async () => {
    clearInterval(timer);
    const signal = (rows, sig) => {
      for (const p of rows.toReversed()) if (owned.get(p.pid) === p.stamp) {
        try { process.kill(p.pid, sig); } catch (e) { if (e.code !== 'ESRCH') inspectionFailed = true; }
      }
    };
    // Freeze observed descendants/root before final discovery to reduce fork races.
    signal(scan(), 'SIGSTOP'); signal(scan(), 'SIGSTOP'); signal(scan(), 'SIGKILL');
    for (let i = 0; i < 20; i++) {
      const rows = snapshot();
      if (!rows.some(p => owned.get(p.pid) === p.stamp)) return !inspectionFailed;
      signal(rows, 'SIGKILL'); await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  };
}
