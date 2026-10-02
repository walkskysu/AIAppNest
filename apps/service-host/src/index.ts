import { hostInputSchema, publicError, type HostOutput } from '@aiappnest/contracts';
import { SERVICE_NODE_VERSION, SERVICE_PROTOCOL_VERSION } from '@aiappnest/domain';

// Only the owning Main process can access this inherited IPC pipe. No network listener.
if (!process.send || process.versions.node !== SERVICE_NODE_VERSION) process.exit(1);
let ready = false;
const handshakeDeadline = setTimeout(() => process.exit(1), 5000);
const send = (message: HostOutput) => {
  if (process.connected) process.send!(message, undefined, undefined, (error) => { if (error) process.exit(1); });
};
process.on('disconnect', () => process.exit(0));
process.on('message', (raw: unknown) => {
  const parsed = hostInputSchema.safeParse(raw);
  if (!parsed.success) {
    send({ kind: 'fatal', error: publicError('PROTOCOL_ERROR') });
    process.exitCode = 1;
    process.disconnect();
    return;
  }
  const message = parsed.data;
  if (message.kind === 'shutdown') { clearTimeout(handshakeDeadline); process.disconnect(); return; }
  if (message.kind === 'hello' && !ready) {
    ready = true;
    clearTimeout(handshakeDeadline);
    send({ kind: 'ready', nonce: message.nonce, version: SERVICE_PROTOCOL_VERSION, pid: process.pid, nodeVersion: process.versions.node });
  } else if (message.kind === 'ping' && ready) {
    send({ kind: 'response', id: message.id, result: { ok: true, value: { text: message.input.text, pid: process.pid, nodeVersion: process.versions.node } } });
  } else {
    send({ kind: 'fatal', error: publicError('PROTOCOL_ERROR') });
    process.disconnect();
  }
});
