// Fault injection is confined to tests; the application has no fault-mode IPC or flags.
const mode = require('node:path').basename(__filename).split('.')[0];
process.on('disconnect', () => process.exit(0));
process.on('message', (message) => {
  if (message.kind === 'hello') {
    if (mode === 'silent') return;
    if (mode === 'malformed') { process.send({ kind: 'ready', version: 999 }); return; }
    process.send({ kind: 'ready', version: 1, nonce: message.nonce, pid: process.pid, nodeVersion: process.versions.node });
  }
  if (message.kind === 'ping') {
    if (mode === 'out-of-order') setTimeout(() => process.send({ kind: 'response', id: message.id, result: { ok: true, value: { text: message.input.text, pid: process.pid, nodeVersion: process.versions.node } } }), message.input.text === 'first' ? 80 : 5);
    if (mode === 'bad-response') process.send({ kind: 'response', id: message.id, result: { ok: true, value: { text: 123 } } });
    // Other modes deliberately never reply, including to shutdown.
  }
});
