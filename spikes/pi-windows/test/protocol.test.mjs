import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonlDecoder } from '../src/jsonl.mjs';
import { Worker } from '../src/worker.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

test('V05 JSONL survives every byte split, Unicode, CRLF, and multiple frames', () => {
  const values = [{ type: 'message_update', text: '中文 🌏' }, { type: 'response', id: 'two', success: true }];
  const bytes = Buffer.from(values.map(v => JSON.stringify(v)).join('\r\n') + '\n');
  for (let i = 0; i <= bytes.length; i++) {
    const got = []; const parser = new JsonlDecoder(v => got.push(v));
    parser.push(bytes.subarray(0, i)); parser.push(bytes.subarray(i)); parser.end(); assert.deepEqual(got, values);
  }
  const got = []; const parser = new JsonlDecoder(v => got.push(v));
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.end(); assert.deepEqual(got, values);
});
test('V05 malformed, invalid UTF-8, oversized and truncated frames fail closed', () => {
  assert.throws(() => new JsonlDecoder(() => {}).push(Buffer.from('{bad}\n')));
  assert.throws(() => new JsonlDecoder(() => {}).push(Buffer.from([34, 0xff, 34, 10])));
  assert.throws(() => new JsonlDecoder(() => {}, 2).push(Buffer.from('123')));
  assert.throws(() => new JsonlDecoder(() => {}, 2).push(Buffer.from('123\n')));
  const parser = new JsonlDecoder(() => {}); parser.push(Buffer.from('{}')); assert.throws(() => parser.end());
});
function fakeWorker() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 1, null);
  return new Worker({}, child);
}
test('V05 responses correlate by id while uncorrelated events interleave; no raw secrets in audit', async () => {
  const w = fakeWorker(); const commands = [];
  w.child.stdin.on('data', chunk => commands.push(JSON.parse(chunk)));
  const a = w.command('get_state'); const b = w.command('get_messages');
  w.receive({ type: 'response', id: commands[1].id, success: true, data: 'B' });
  w.receive({ type: 'message_update', secret: 'TEST_KEY' });
  w.receive({ type: 'TEST_KEY', id: 'TEST_KEY' });
  w.receive({ type: 'response', id: commands[0].id, success: true, data: 'A' });
  assert.equal((await a).data, 'A'); assert.equal((await b).data, 'B');
  assert.ok(!JSON.stringify(w.audit).includes('TEST_KEY')); await w.close(true);
});
test('V06 accepted prompt cannot complete without terminal evidence; timeout retires worker', async () => {
  const w = fakeWorker();
  w.child.stdin.on('data', chunk => { const c = JSON.parse(chunk); w.receive({ type: 'response', id: c.id, success: true }); });
  const running = w.run('prompt', 25);
  await assert.rejects(w.run('second'), /active run/);
  await assert.rejects(running, /timeout/); assert.ok(w.closed);
});
test('V06 process exit rejects pending command', async () => {
  const w = fakeWorker(); const pending = w.command('get_state'); w.child.kill();
  await assert.rejects(pending, /exited/);
});

test('V06 command timeout rejects all pending requests and retires worker', async () => {
  const w = fakeWorker();
  const first = assert.rejects(w.command('get_state', {}, 20), /timeout/);
  const second = assert.rejects(w.command('get_messages'), /timeout/);
  await Promise.all([first, second]);
  assert.ok(w.closed); assert.equal(w.pending.size, 0);
  await assert.rejects(w.command('get_state'), /timeout/);
});

test('V09 abort acknowledgment without run completion forces retirement at deadline', async () => {
  const w = fakeWorker();
  w.child.stdin.on('data', chunk => {
    const c = JSON.parse(chunk); w.receive({ type: 'response', id: c.id, success: true });
  });
  const run = assert.rejects(w.run('work'), /exited/);
  assert.equal(await w.cancel(30), 'forced');
  await run; assert.ok(w.closed);
});

test('V06 agent_end plus idle state requires a matching completed assistant message', async () => {
  for (const kind of ['missing', 'mismatch', 'length', 'toolUse', 'stop']) {
    const w = fakeWorker();
    const assistant = { role: 'assistant', content: [{ type: 'text', text: 'result' }], stopReason: kind === 'length' || kind === 'toolUse' ? kind : 'stop' };
    w.child.stdin.on('data', chunk => {
      const c = JSON.parse(chunk);
      if (c.type === 'prompt' && c.message === 'work') {
        w.receive({ type: 'agent_start' });
        w.receive({ type: 'message_end', message: assistant });
        w.receive({ type: 'agent_end' }); // Events may precede command acceptance.
      }
      const messages = kind === 'missing' ? [] : [kind === 'mismatch' ? { ...assistant, content: [] } : assistant];
      const data = c.type === 'get_state' ? { isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
        : c.type === 'get_messages' ? { messages } : undefined;
      w.receive({ type: 'response', id: c.id, success: true, data });
    });
    assert.equal((await w.run('work')).status, kind === 'stop' ? 'succeeded' : 'failed', kind);
    await w.close(true);
  }
});
test('managed RPC never exposes shell or session-switch commands', async () => {
  const w = fakeWorker();
  for (const command of ['bash', 'new_session', 'switch_session', 'steer', 'follow_up']) await assert.rejects(w.command(command), /not allowed/);
  await assert.rejects(w.command('prompt', { message: 'bypass' }), /Use run/);
  w.busy = true;
  await assert.rejects(w.command('prompt', { message: '/spike-inspect' }), /Use run/);
  await w.close(true);
});
