import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { fixture, runtime, ok, until, PiAdapter, JsonlDecoder } from './fixtures/engine-harness.mjs';

test('E02 JSONL handles every UTF-8 boundary, multiple lines, CRLF and invalid/truncated/oversize frames', () => {
  const expected = readFileSync('tests/integration/fixtures/engine-protocol.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const wire = Buffer.from(expected.map(v => JSON.stringify(v)).join('\r\n') + '\n');
  for (let split = 0; split <= wire.length; split++) {
    const values = [], decoder = new JsonlDecoder(value => values.push(value));
    decoder.push(wire.subarray(0, split)); decoder.push(wire.subarray(split)); decoder.end(); assert.deepEqual(values, expected);
  }
  for (const wire of [Buffer.from('{bad}\n'), Buffer.from([0xff,10]), Buffer.from('null\n'), Buffer.from('{}\n')]) assert.throws(() => new JsonlDecoder(() => {}).push(wire));
  const truncated = new JsonlDecoder(() => {}); truncated.push(Buffer.from('{')); assert.throws(() => truncated.end());
  assert.throws(() => new JsonlDecoder(() => {}, 4).push(Buffer.from('12345')));
});

test('E01/E06 actual Windows Pi streams, maps exact session and restores without replay across revision changes', { timeout: 45000 }, async t => {
  const f = await fixture(t), worker = await f.start(), runId = f.run();
  const result = await worker.prompt(runId, 'unique-memory-标记');
  assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 5 });
  const events = worker.readEvents().events;
  assert.ok(events.some(e => e.type === 'assistant.delta' && e.payload.text.includes('你好')));
  assert.ok(events.filter(e => e.runId).every(e => e.runId === runId && e.conversationId === f.conversation.id && e.revisionId === f.conversation.revisionId));
  const before = await worker.getMessages(), state = await worker.getState();
  assert.equal(f.storage.conversations.get({ appId: f.app.id, id: f.conversation.id }).piSessionFile, state.sessionFile);
  assert.ok(existsSync(state.sessionFile)); await worker.close();
  let app = ok(f.apps.request({ operation: 'update', appId: f.app.id, expectedVersion: f.app.version, metadata: f.metadata, draft: { ...f.app.draft, role: 'NEW ROLE MUST NOT LOAD' } })).app;
  ok(f.apps.request({ operation: 'publish', appId: app.id, expectedVersion: app.version }));
  const count = f.requests.length, restored = await f.start(true);
  assert.deepEqual(await restored.getMessages(), before); assert.equal(f.requests.length, count);
  assert.equal((await restored.getState()).sessionFile, state.sessionFile);
  assert.equal((await restored.prompt(f.run(), 'recall')).status, 'succeeded');
  assert.match(JSON.stringify(await restored.getMessages()), /unique-memory-标记/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body), /NEW ROLE MUST NOT LOAD/);
});

test('E03 handled command ends without model work; arbitrary extension commands rejected', async t => {
  const f = await fixture(t), worker = await f.start();
  assert.equal((await worker.prompt(f.run(), '/aiappnest-handled')).status, 'handled'); assert.equal(f.requests.length, 0);
  await assert.rejects(worker.prompt(f.run(), '/aiappnest-barrier'), /INVALID_INPUT/);
});

test('E04/E09 accepted slow prompt remains running, rejects overlap and cooperative abort supplies evidence', async t => {
  const f = await fixture(t), worker = await f.start(), runId = f.run();
  const pending = worker.prompt(runId, 'slow'); let done = false; pending.then(() => { done = true; });
  await until(() => f.requests.length === 1); await delay(75); assert.equal(done, false);
  worker.receive({ type: 'agent_end', messages: [] });
  await delay(75); assert.equal(done, false, 'premature agent_end must wait for real idle barrier');
  await assert.rejects(worker.prompt(randomUUID(), 'overlap'), /INVALID_STATE/);
  const evidence = await worker.abort(3000), result = await pending;
  assert.equal(result.status, 'cancelled'); assert.equal(evidence.requested, true); assert.ok(evidence.idle || evidence.exited);
});

test('E02 command responses match IDs even when delivered in reverse order among unknown events', async t => {
  const f = await fixture(t), worker = await f.start();
  const original = worker.receive.bind(worker), held = [];
  worker.receive = value => {
    if (value.type !== 'response') return original(value);
    held.push(value);
    if (held.length === 2) { original(held[1]); original({ type: 'future_compatible_event', data: 'ignored' }); original(held[0]); }
  };
  const [state, messages] = await Promise.all([worker.getState(), worker.getMessages()]);
  assert.equal(state.status, 'idle'); assert.deepEqual(messages, []); assert.equal(worker.readEvents().unknownEvents, 1);
  worker.receive = original;
});

test('E09 unexpected actual process exit keeps exit evidence and never becomes cancellation', async t => {
  const f = await fixture(t), worker = await f.start(), pending = worker.prompt(f.run(), 'slow');
  await until(() => f.requests.length === 1); worker.child.kill();
  const result = await pending;
  assert.equal(result.status, 'interrupted'); assert.equal(result.error, 'PROCESS_EXIT'); assert.equal(result.cancellation.requested, false);
  assert.ok(result.exitCode !== null || result.signal !== null);
});

test('E09 abort deadline forces actual Job teardown when abort acknowledgment is lost', async t => {
  const f = await fixture(t), worker = await f.start(), pending = worker.prompt(f.run(), 'slow');
  await until(() => f.requests.length === 1);
  // Suppress a response through the transport, preserving the real adapter deadline timer.
  const receive = worker.receive.bind(worker);
  worker.receive = value => { if (value.type !== 'response' || value.command !== 'abort') receive(value); };
  const evidence = await worker.abort(80), result = await pending;
  assert.equal(evidence.forced, true); assert.equal(evidence.exited, true); assert.equal(evidence.acknowledged, false);
  assert.equal(result.status, 'cancelled');
});

test('E09 cancelling a real permission wait rejects pending approval before any file write', async t => {
  const f = await fixture(t, { permissions: { mode: 'controlled-files', tools: ['write'] } });
  const grant = f.policyRequest({ operation: 'grants.create', resource: 'workspace', access: 'write', confirmation: 'always' }).grant;
  const worker = await f.start(), runId = f.run();
  const result = worker.prompt(runId, 'tool:' + JSON.stringify({ name: 'platform_write', args: { grantId: grant.id, path: 'cancelled.txt', content: 'never' } }));
  const approvals = () => f.policyRequest({ operation: 'approvals.list', runId }).approvals;
  await until(() => approvals().some(a => a.state === 'pending'));
  const evidence = await worker.abort(3000);
  assert.equal((await result).status, 'cancelled'); assert.ok(evidence.idle || evidence.exited);
  assert.equal(existsSync(join(grant.root, 'cancelled.txt')), false); assert.ok(approvals().every(a => a.state === 'cancelled'));
});

test('E08/E11 extension tamper, snapshot damage, ambient config and session cross-owner paths fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(PiAdapter.start(f.services, { ...runtime, hashes: { ...runtime.hashes, extension: '0'.repeat(64) } }, f.app.id, f.conversation.id), /VERSION_MISMATCH/);
  const revision = f.storage.paths.revision(f.app.id, f.conversation.revisionId), role = join(revision, 'role.md'), before = readFileSync(role);
  writeFileSync(role, 'tampered'); await assert.rejects(f.start(), /RESOURCE_INVALID/); writeFileSync(role, before);
  const worker = await f.start(); await worker.prompt(f.run(), 'persist'); const file = (await worker.getState()).sessionFile; await worker.close();
  const agent = f.storage.paths.conversation(f.app.id, f.conversation.id, 'agent');
  writeFileSync(join(agent, 'models.json'), '{}'); await assert.rejects(f.start(true), /RESOURCE_INVALID/); rmSync(join(agent, 'models.json'));
  const get = f.storage.conversations.get.bind(f.storage.conversations);
  f.storage.conversations.get = scope => ({ ...get(scope), piSessionFile: join(f.root, 'outside.jsonl') });
  writeFileSync(join(f.root, 'outside.jsonl'), readFileSync(file)); await assert.rejects(f.start(true), /SESSION_INVALID/);
  f.storage.conversations.get = get;
});

test('E09 production Job Object kills owned descendants and leaves unrelated process alive', async t => {
  const env = { SystemRoot: process.env.SystemRoot };
  const unrelated = spawn(runtime.node, ['-e', 'setInterval(()=>{},1000)'], { env, windowsHide: true, shell: false, stdio: 'ignore' });
  const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); console.log(JSON.stringify([process.pid,c.pid])); setInterval(()=>{},1000);`;
  const identity=execFileSync(runtime.nativeHost,['identity',String(process.pid)],{ windowsHide:true,encoding:'utf8' }).trim();
  const job = spawn(runtime.nativeHost, ['job', String(process.pid), identity, runtime.node, '-e', script], { env, windowsHide: true, shell: false });
  const exited = new Promise(resolve => job.once('close', resolve));
  t.after(async () => { job.kill(); unrelated.kill(); await exited; });
  let output = ''; job.stdout.on('data', chunk => { output += chunk; }); job.stderr.resume();
  await until(() => output.includes('\n'));
  const pids = JSON.parse(output.trim()); job.kill(); await exited;
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await until(() => pids.every(pid => !alive(pid)));
  assert.equal(alive(unrelated.pid), true);
});

test('E09 model errors and truncated completions never succeed', async t => {
  const f = await fixture(t), worker = await f.start();
  const failed = await worker.prompt(f.run(), 'model-error'); assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'MODEL_ERROR');
  const length = await worker.prompt(f.run(), 'length'); assert.equal(length.status, 'failed'); assert.equal(length.error, 'INCOMPLETE_RESULT');
});

test('E05 two actual Workers keep credentials, role and events private', async t => {
  const a = await fixture(t, { secret: 'test-secret-A', role: 'ROLE_A', skillBody: 'SKILL_A' }), b = await fixture(t, { secret: 'test-secret-B', role: 'ROLE_B', skillBody: 'SKILL_B' });
  const before = { ...process.env }, wa = await a.start(), wb = await b.start();
  const result = await Promise.all([wa.prompt(a.run(), 'A'), wb.prompt(b.run(), 'B')]);
  assert.ok(result.every(r => r.status === 'succeeded')); assert.deepEqual({ ...process.env }, before);
  assert.equal(a.requests[0].headers.authorization, 'Bearer test-secret-A'); assert.equal(b.requests[0].headers.authorization, 'Bearer test-secret-B');
  assert.doesNotMatch(JSON.stringify(a.requests), /ROLE_B|test-secret-B/); assert.doesNotMatch(JSON.stringify(b.requests), /ROLE_A|test-secret-A/);
  assert.equal((await wa.prompt(a.run(), '/skill:identity')).status, 'succeeded');
  assert.equal((await wb.prompt(b.run(), '/skill:identity')).status, 'succeeded');
  assert.match(JSON.stringify(a.requests.at(-1).body), /SKILL_A/); assert.doesNotMatch(JSON.stringify(a.requests.at(-1).body), /SKILL_B/);
  assert.match(JSON.stringify(b.requests.at(-1).body), /SKILL_B/); assert.doesNotMatch(JSON.stringify(b.requests.at(-1).body), /SKILL_A/);
  for (const f of [a,b]) {
    const agent = f.storage.paths.conversation(f.app.id, f.conversation.id, 'agent');
    assert.doesNotMatch(readFileSync(join(agent, 'engine.json'), 'utf8'), /test-secret/);
  }
  const skillFile = a.apps.resolveSkills(a.app.id, a.conversation.revisionId).paths[0];
  writeFileSync(skillFile, 'tampered'); await assert.rejects(wa.prompt(a.run(), 'cannot run with tampered Skill'), /RESOURCE_INVALID/);
});

test('E08 real controlled tools use host grants; handled tool errors can recover to a successful final assistant', async t => {
  const f = await fixture(t, { permissions: { mode: 'controlled-files', tools: ['read', 'write'] } });
  const grant = f.policyRequest({ operation: 'grants.create', resource: 'workspace', access: 'write', confirmation: 'never' }).grant;
  const worker = await f.start();
  const result = await worker.prompt(f.run(), 'tool:' + JSON.stringify({ name: 'platform_write', args: { grantId: grant.id, path: 'allowed.txt', content: 'written' } }));
  assert.equal(result.status, 'succeeded'); assert.equal(readFileSync(join(grant.root, 'allowed.txt'), 'utf8'), 'written');
  const denied = await worker.prompt(f.run(), 'tool:' + JSON.stringify({ name: 'platform_write', args: { grantId: grant.id, path: '../escape', content: 'no' } }));
  assert.equal(denied.status, 'succeeded'); assert.equal(denied.toolErrors, 1); assert.equal(existsSync(join(grant.root, '../escape')), false);
  assert.ok(worker.readEvents().events.some(e => e.type === 'tool.result' && e.payload.isError));
});

test('E07 mapping failure closes worker and leaves no association', async t => {
  const f = await fixture(t), original = f.storage.attachSessionFile.bind(f.storage);
  f.storage.attachSessionFile = () => { throw Error('disk failure'); };
  await assert.rejects(f.start(), /MAPPING_FAILED/);
  assert.equal(f.storage.conversations.get({ appId: f.app.id, id: f.conversation.id }).piSessionFile, null);
  f.storage.attachSessionFile = original;
  const worker = await f.start(); assert.equal((await worker.prompt(f.run(), 'after failed map')).status, 'succeeded');
});

test('E06/E11 corrupt or missing session is rejected without replacement', async t => {
  const f = await fixture(t), worker = await f.start(); await worker.prompt(f.run(), 'persist');
  const file = (await worker.getState()).sessionFile; await worker.close(); const original = readFileSync(file);
  for (const content of ['', '{bad}\n', original.toString().replace('"version":3', '"version":999'), original + '{bad}\n']) {
    writeFileSync(file, content); await assert.rejects(f.start(true), /SESSION_INVALID/); assert.equal(readFileSync(file, 'utf8'), content);
  }
  rmSync(file); await assert.rejects(f.start(true), /SESSION_INVALID/); assert.equal(existsSync(file), false);
});

test('E10 unsubscribed stdout is consumed and projection stays bounded', async t => {
  const f = await fixture(t), worker = await f.start(false, { bufferBytes: 4096, bufferEvents: 8, onEvent() { throw Error('UI gone'); } });
  assert.equal((await worker.prompt(f.run(), 'large')).status, 'succeeded');
  const view = worker.readEvents(); assert.ok(view.bufferedBytes <= 4096); assert.ok(view.events.length <= 8); assert.ok(view.dropped > 0);
  assert.ok(JSON.stringify(await worker.getMessages()).length > 100000);
});

test('E11 pinned runtime mismatch fails before spawning or writing session mapping', async t => {
  const f = await fixture(t);
  await assert.rejects(PiAdapter.start(f.services, { ...runtime, versions: { ...runtime.versions, pi: 'latest' } }, f.app.id, f.conversation.id), /VERSION_MISMATCH/);
  assert.equal(f.storage.conversations.get({ appId: f.app.id, id: f.conversation.id }).piSessionFile, null);
});

test('E08 startup timeout reclaims Worker and releases the session lease', async t => {
  const f = await fixture(t);
  await assert.rejects(f.start(false, { startupMs: 1 }), /START_TIMEOUT/);
  assert.equal(f.storage.conversations.get({ appId: f.app.id, id: f.conversation.id }).piSessionFile, null);
  const worker = await f.start(); assert.equal((await worker.getState()).status, 'idle');
  await assert.rejects(f.start(), /INVALID_STATE/);
});

test('E08 actual CLI extension session_start failure cannot launch a usable Worker', async t => {
  const f = await fixture(t), extension = join(f.root, 'failing-extension.mjs');
  writeFileSync(extension, `import real from ${JSON.stringify(pathToFileURL(runtime.extension).href)}; export default async function(pi) { await real(pi); pi.on('session_start', () => { throw Error('FIXTURE_INIT_FAILURE'); }); }`);
  const bad = { ...runtime, extension, hashes: { ...runtime.hashes, extension: createHash('sha256').update(readFileSync(extension)).digest('hex') } };
  await assert.rejects(PiAdapter.start(f.services, bad, f.app.id, f.conversation.id), /EXTENSION_FAILED/);
  assert.equal(f.storage.conversations.get({ appId: f.app.id, id: f.conversation.id }).piSessionFile, null);
});

test('E02 fatal invalid stdout retires pending calls and actual Worker without replay', async t => {
  const f = await fixture(t), worker = await f.start(), pending = worker.prompt(f.run(), 'slow');
  await until(() => f.requests.length === 1);
  worker.child.stdout.emit('data', Buffer.from('{invalid}\n'));
  const result = await pending; assert.equal(result.status, 'interrupted'); assert.equal(result.error, 'PROTOCOL_ERROR');
  assert.equal(worker.closed, true); assert.equal(worker.pending.size, 0); assert.equal(f.requests.length, 1);
});
