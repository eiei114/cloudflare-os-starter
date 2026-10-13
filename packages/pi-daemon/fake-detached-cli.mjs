import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const c = JSON.parse(line); emit({ type: 'response', id: c.id, success: true });
  if (c.type === 'prompt') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' });
    writeFileSync(process.env.TEST_PID_FILE, String(child.pid)); child.unref();
    // Deliberately never acknowledge abort/settlement.
  }
});
