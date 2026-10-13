// Test fixture: native child-process pipes, no model calls or local Pi profile access.
import { createInterface } from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  emit({ type: 'response', id: command.id, command: command.type, success: true });
  if (command.type === 'prompt') {
    emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'native-pipe-test' }] } });
    emit({ type: 'agent_settled' });
  }
});
