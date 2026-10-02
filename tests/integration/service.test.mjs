import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ServiceManager, serviceEnvironment } from '../../dist/service-manager.cjs';

const entry = resolve('dist/service-host.cjs');
const options = { entry, nodePath: process.execPath, startupMs: 2000, requestMs: 300, shutdownMs: 100 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await wait(30); } throw new Error('Condition timed out'); }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function fault(t, mode) {
  const dir = await mkdtemp(resolve('.test-fault-'));
  const path = join(dir, `${mode}.cjs`);
  await copyFile(resolve('tests/integration/fixtures/fault-host.cjs'), path);
  const manager = new ServiceManager({ ...options, entry: path, startupMs: 350 });
  t.after(async () => { await manager.stop(); await rm(dir, { recursive: true, force: true }); });
  return manager;
}

test('F01/F03/F08 actual Node host handshake, concurrent requests, no duplicate start, clean stop', async (t) => {
  const manager = new ServiceManager(options);
  t.after(() => manager.stop());
  const [a, b] = await Promise.all([manager.start(), manager.start()]);
  assert.equal(a.ok, true); assert.deepEqual(a, b);
  const pid = a.value.pid;
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => manager.ping({ text: `中文 ${i}` })));
  results.forEach((r, i) => { assert.equal(r.ok, true); assert.equal(r.value.text, `中文 ${i}`); assert.equal(r.value.pid, pid); assert.equal(r.value.nodeVersion, '24.19.0'); });
  assert.equal((await manager.start()).value.pid, pid);
  await manager.stop();
  assert.equal(alive(pid), false);
  assert.equal(manager.snapshot().phase, 'stopped');
});

test('F04 strict service input validation rejects arbitrary methods and extra properties', async () => {
  for (const raw of [{ kind: 'exec', command: 'anything' }, { kind: 'hello', version: 1, nonce: 'bad' }, { kind: 'ping', id: 'bad', input: { text: 'x', path: 'secret' } }]) {
    const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const message = once(child, 'message'); const exit = once(child, 'exit');
    child.send(raw);
    assert.equal((await message)[0].error.code, 'PROTOCOL_ERROR');
    await exit;
  }
});

test('F05 unavailable runtime, missing entry, silent handshake and incompatible protocol fail explicitly', async (t) => {
  for (const override of [{ nodePath: resolve('missing-node.exe') }, { entry: resolve('missing-entry.cjs') }]) {
    const manager = new ServiceManager({ ...options, ...override });
    assert.equal((await manager.start()).ok, false);
    await manager.stop();
  }
  const silent = await fault(t, 'silent');
  assert.equal((await silent.start()).error.code, 'START_TIMEOUT');
  const malformed = await fault(t, 'malformed');
  assert.equal((await malformed.start()).error.code, 'PROTOCOL_ERROR');
});

test('F06/F07 actual host crash fails visibly; explicit retry starts a new generation', async (t) => {
  const manager = new ServiceManager(options); t.after(() => manager.stop());
  const first = await manager.start();
  process.kill(first.value.pid);
  await until(() => manager.snapshot().phase === 'failed');
  assert.equal((await manager.ping({ text: 'not replayed' })).error.code, 'NOT_READY');
  const restarted = await manager.start();
  assert.equal(restarted.ok, true); assert.notEqual(restarted.value.pid, first.value.pid);
});

test('F09 timeout rejects all pending without replay and bounds shutdown of unresponsive host', async (t) => {
  const manager = await fault(t, 'hung');
  const started = await manager.start(); assert.equal(started.ok, true);
  const results = await Promise.all([manager.ping({ text: 'a' }), manager.ping({ text: 'b' })]);
  assert.ok(results.every((r) => r.error.code === 'REQUEST_TIMEOUT'));
  await until(() => !alive(started.value.pid));
  assert.equal(manager.snapshot().phase, 'failed');
  const hung = await fault(t, 'hung');
  const active = await hung.start();
  const pending = hung.ping({ text: 'a' });
  await hung.stop();
  assert.equal((await pending).error.code, 'SHUTTING_DOWN');
  assert.equal(alive(active.value.pid), false);
  assert.equal((await hung.start()).error.code, 'SHUTTING_DOWN');
});

test('F04/F09 malformed service output fails closed; response IDs correlate out of order', async (t) => {
  const malformed = await fault(t, 'bad-response'); await malformed.start();
  assert.equal((await malformed.ping({ text: 'a' })).error.code, 'PROTOCOL_ERROR');
  const ordered = await fault(t, 'out-of-order'); await ordered.start();
  const results = await Promise.all(['first', 'second'].map((text) => ordered.ping({ text })));
  assert.deepEqual(results.map((r) => r.value.text), ['first', 'second']);
});

test('F13 host environment excludes credentials and Node injection; invalid input never sent', async (t) => {
  process.env.FOUNDATION_TEST_SECRET = 'non-secret-test-marker';
  process.env.NODE_OPTIONS = '--trace-warnings';
  try { assert.equal(serviceEnvironment().FOUNDATION_TEST_SECRET, undefined); assert.equal(serviceEnvironment().NODE_OPTIONS, undefined); }
  finally { delete process.env.FOUNDATION_TEST_SECRET; delete process.env.NODE_OPTIONS; }
  const manager = new ServiceManager(options); t.after(() => manager.stop()); await manager.start();
  for (const input of [null, { text: 'x', command: 'anything' }, { text: 'x'.repeat(257) }]) assert.equal((await manager.ping(input)).error.code, 'INVALID_INPUT');
  assert.equal(manager.snapshot().phase, 'ready');
});
