import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ServiceManager } from '../../dist/service-manager.cjs';
import { fixture, runtime, ok, until, RunScheduler, PiAdapter } from './fixtures/engine-harness.mjs';

const finished = run => run.phase === 'completed';
function harness(f, options = {}) {
  const scheduler = new RunScheduler(f.services, runtime, options); f.schedulers.push(scheduler);
  const input = (text = 'hello', conversation = f.conversation, requestId = randomUUID()) => ({ operation: 'submit',
    appId: f.app.id, conversationId: conversation.id, revisionId: conversation.revisionId, requestId, text, attachmentIds: [] });
  const submit = (...args) => ok(scheduler.request(input(...args))).run;
  const get = run => ok(scheduler.request({ operation: 'get', appId: run.appId, conversationId: run.conversationId, runId: run.id })).run;
  const cancel = run => ok(scheduler.request({ operation: 'cancel', appId: run.appId, conversationId: run.conversationId, runId: run.id }));
  const done = async run => { await until(() => finished(get(run))); return get(run); };
  const conversation = () => f.storage.createConversation(f.app.id, randomUUID(), 'another');
  return { scheduler, input, submit, get, cancel, done, conversation };
}
function controlled(options = {}) {
  const starts = [], live = new Map(), workers = [];
  return { starts, live, workers,
    prepare: input => ({ model: options.model?.(input) ?? 'model', local: false, roots: options.roots?.(input) ?? [], exclusive: false, text: input.text, snapshot: {} }),
    open: async (run, signal, onEvent) => {
      if (options.open) await options.open(run, signal);
      const worker = { closed: false, prompts: 0, current: null,
        prompt(runId, text) {
          this.prompts++; starts.push({ runId, text, conversationId: run.conversationId });
          onEvent({ runId, type: 'status', payload: { state: 'accepted' } });
          return new Promise(resolve => {
            this.current = runId;
            live.set(runId, (status = 'succeeded') => {
              this.current = null; live.delete(runId);
              resolve({ runId, status, toolErrors: 0, usage: { inputTokens: 1, outputTokens: 2 },
                cancellation: { requested: status === 'cancelled', idle: true, exited: false, forced: false, acknowledged: true } });
            });
          });
        },
        async abort() { if (options.abortDelay) await delay(options.abortDelay); live.get(this.current)?.('cancelled'); },
        async close() { this.closed = true; live.get(this.current)?.('interrupted'); },
        async getMessages() { return [{ role: 'assistant', content: [{ type: 'text', text: 'complete answer' }] }]; },
      };
      workers.push(worker); return worker;
    },
  };
}

test('R01/R03 concurrent duplicate submissions have one message and serial prompts; payload conflicts reject', async t => {
  const f = await fixture(t), c = controlled(), h = harness(f, c), input = h.input();
  const replies = await Promise.all(Array.from({ length: 30 }, () => Promise.resolve(h.scheduler.request(input))));
  assert.ok(replies.every(r => r.ok && r.value.run.id === replies[0].value.run.id));
  const a = replies[0].value.run, b = h.submit('second');
  assert.equal(h.scheduler.request({ ...input, text: 'different' }).error.code, 'VERSION_CONFLICT');
  await until(() => c.starts.length === 1); assert.equal(h.get(b).state, 'queued');
  c.live.get(a.id)(); await h.done(a); await until(() => c.starts.length === 2);
  c.live.get(b.id)(); assert.equal((await h.done(b)).state, 'succeeded');
  assert.equal(c.workers.length, 1);
  assert.equal(f.storage.messages.list({ appId: a.appId, conversationId: a.conversationId }).filter(m => m.role === 'user').length, 2);
  assert.equal(ok(h.scheduler.request(input)).duplicate, true);
});

test('R02 model caps nest within global cap; older eligible model requests do not starve', async t => {
  const f = await fixture(t), c = controlled({ model: input => input.text }), h = harness(f, { ...c, concurrency: 2, modelLimits: { a: 1, b: 9 } });
  const runs = ['a','a','b','b'].map(model => h.submit(model, h.conversation()));
  await until(() => c.starts.length === 2);
  assert.deepEqual(c.starts.map(s => s.runId), [runs[0].id, runs[2].id]);
  assert.equal(c.live.size, 2); c.live.get(runs[0].id)();
  await until(() => c.starts.length === 3); assert.equal(c.starts[2].runId, runs[1].id);
  c.live.get(runs[2].id)(); await until(() => c.starts.length === 4);
  for (const finish of [...c.live.values()]) finish(); await Promise.all(runs.map(h.done));
});

test('R04 overlapping parent/child write roots serialize with FIFO reservation; siblings proceed', async t => {
  const f = await fixture(t), c = controlled({ roots: input => [input.text] }), h = harness(f, { ...c, concurrency: 3 });
  const a = h.submit(join(f.root, 'parent'), h.conversation()), b = h.submit(join(f.root, 'parent/child'), h.conversation());
  const other = h.submit(join(f.root, 'parent2'), h.conversation());
  await until(() => c.starts.length === 2); assert.equal(h.get(b).state, 'queued');
  c.live.get(a.id)(); await until(() => c.starts.length === 3); c.live.get(b.id)(); c.live.get(other.id)();
  await Promise.all([a,b,other].map(h.done));
});

test('R05 queued and starting cancellation, repeat cancel, bounded queue and timeout release capacity', async t => {
  const f = await fixture(t); let opening;
  const c = controlled({ open: (_run, signal) => new Promise(resolve => { opening = true; signal.addEventListener('abort', resolve, { once: true }); }) });
  const h = harness(f, { ...c, concurrency: 1, queueLimit: 1, queueTimeoutMs: 80 });
  const a = h.submit(); await until(() => opening);
  const b = h.submit('queued'); assert.equal(h.scheduler.request(h.input('overflow')).error.code, 'BUSY');
  assert.equal(h.cancel(b).terminated, true); assert.equal(h.cancel(b).run.state, 'cancelled');
  const timeout = h.submit('timeout'); assert.equal((await h.done(timeout)).error, 'QUEUE_TIMEOUT');
  assert.equal(h.cancel(a).run.state, 'cancelling'); assert.equal((await h.done(a)).state, 'cancelled');
  assert.equal(c.starts.length, 0); assert.ok(c.workers.every(w => w.closed));
});

test('R06/R07 cancellation receipt precedes termination; late natural success cannot win', async t => {
  const f = await fixture(t), c = controlled({ abortDelay: 100 }), h = harness(f, c), a = h.submit();
  await until(() => c.live.has(a.id));
  const queued = h.submit('must not start after stop');
  const before = performance.now(), receipt = h.cancel(a), elapsed = performance.now() - before;
  assert.equal(receipt.terminated, false); assert.equal(receipt.run.state, 'cancelling'); assert.ok(elapsed < 200);
  c.live.get(a.id)(); assert.equal((await h.done(a)).state, 'cancelled');
  const completions = f.storage.events.list({ runId: a.id }).filter(e => e.type === 'run.completed');
  assert.equal(completions.length, 1); assert.equal(c.workers[0].closed, true);
  assert.equal(h.get(queued).state, 'cancelled'); assert.equal(c.starts.length, 1);
  t.diagnostic(`cancel receipt ${elapsed.toFixed(1)}ms; deterministic delayed-abort fixture, SQLite FULL/WAL`);
});

test('R09 durable cursor subscriptions page history and live output with no gaps; unsubscribe and slow clients bounded', async t => {
  const f = await fixture(t), c = controlled(), h = harness(f, c), a = h.submit();
  await until(() => c.live.has(a.id));
  for (let i = 0; i < 300; i++) h.scheduler.engineEvent({ runId: a.id, type: 'assistant.delta', payload: { text: 'x'.repeat(3000) } });
  let reply = ok(h.scheduler.request({ operation: 'subscribe', appId: a.appId, conversationId: a.conversationId, runId: a.id, afterSeq: 0 }));
  const events = [...reply.events]; assert.ok(reply.events.length < 128); const firstCursor = reply.afterSeq;
  c.live.get(a.id)(); await h.done(a);
  while (!reply.terminal) { reply = ok(h.scheduler.request({ operation: 'next', subscriptionId: reply.subscriptionId, afterSeq: reply.afterSeq })); events.push(...reply.events); }
  assert.deepEqual(events.map(e => e.seq), Array.from({ length: events.length }, (_, i) => i + 1));
  assert.equal(events.at(-1).type, 'run.completed');
  const replay = ok(h.scheduler.request({ operation: 'next', subscriptionId: reply.subscriptionId, afterSeq: firstCursor }));
  assert.equal(replay.events[0].seq, firstCursor + 1);
  ok(h.scheduler.request({ operation: 'unsubscribe', subscriptionId: reply.subscriptionId }));
  assert.equal(h.scheduler.request({ operation: 'next', subscriptionId: reply.subscriptionId, afterSeq: 0 }).error.code, 'NOT_FOUND');
  assert.equal(h.scheduler.pending.length, 0);
});

test('R10 idle TTL never reaps active workers; R11 launch failures and worker errors release queue', async t => {
  const f = await fixture(t); let opens = 0;
  const c = controlled({ open: async () => { if (++opens === 1) throw Error('spawn failure'); } });
  const h = harness(f, { ...c, idleTtlMs: 50 }), a = h.submit(), b = h.submit('next');
  assert.equal((await h.done(a)).state, 'failed'); await until(() => c.live.has(b.id));
  await delay(100); assert.equal(c.workers[0].closed, false);
  c.live.get(b.id)('interrupted'); assert.equal((await h.done(b)).state, 'interrupted');
  const d = h.submit('works'); await until(() => c.live.has(d.id)); c.live.get(d.id)(); await h.done(d);
  await until(() => c.workers.at(-1).closed); assert.equal(h.scheduler.active.size, 0);
});

test('R12 shutdown cancels queue/active, seals admission and restart never replays old runs', async t => {
  const f = await fixture(t), c = controlled(), h = harness(f, c), a = h.submit(), b = h.submit('queued');
  await until(() => c.live.has(a.id)); await h.scheduler.close();
  assert.equal(h.get(a).state, 'cancelled'); assert.equal(h.get(b).state, 'cancelled');
  assert.equal(h.scheduler.request(h.input()).error.code, 'SHUTTING_DOWN');
  const old = f.run();
  const restarted = harness(f, c); assert.equal(f.storage.runs.get({ appId: f.app.id, id: old }).state, 'interrupted');
  assert.equal(c.starts.length, 1); await restarted.scheduler.close();
});

test('submission validates scope, pinned revision, bytes, attachment ownership, configuration before persistence', async t => {
  const f = await fixture(t), h = harness(f), input = h.input();
  for (const patch of [{ appId: randomUUID() }, { conversationId: randomUUID() }, { revisionId: randomUUID() },
    { text: '界'.repeat(400000) }, { text: '/aiappnest-barrier' }, { attachmentIds: [randomUUID()] }]) {
    assert.equal(h.scheduler.request({ ...input, ...patch }).ok, false);
  }
  assert.equal(f.storage.runs.list({ appId: f.app.id, conversationId: f.conversation.id }).length, 0);
});

test('R04 canonical grant roots refresh while queued and newly granted writes cannot evade locks', async t => {
  const f = await fixture(t, { permissions: { mode: 'controlled-files', tools: ['write'] } }), c = controlled();
  const h = harness(f, { open: c.open, concurrency: 3, localConcurrency: 3 });
  const root = join(f.root, 'external'); mkdirSync(root); mkdirSync(join(root, 'child'));
  const first = h.conversation(), second = h.conversation();
  const grant = (conversation, path) => f.storage.savePolicyRecord('grant', { id: randomUUID(), appId: f.app.id, conversationId: conversation.id,
    revisionId: conversation.revisionId, resource: 'external', root: path, access: 'write', confirmation: 'never', version: 1, revoked: false, createdAt: Date.now() });
  grant(first, root);
  const a = h.submit('first', first), b = h.submit('child', second);
  // Admission already happened; dispatch must observe and lock this additional authority.
  grant(second, join(root, './child'));
  await until(() => c.live.has(a.id)); await delay(80); assert.equal(h.get(b).state, 'queued');
  c.live.get(a.id)(); await until(() => c.live.has(b.id)); c.live.get(b.id)(); await h.done(b);
  const snapshot = f.storage.events.list({ runId: b.id }).find(e => e.type === 'run.snapshot');
  assert.equal(snapshot.payload.grants.length, 1);
});

test('R02 production local model default quota is one while global quota remains two', async t => {
  const f = await fixture(t), c = controlled(), h = harness(f, { open: c.open });
  const a = h.submit('a', h.conversation()), b = h.submit('b', h.conversation());
  await until(() => c.live.has(a.id)); await delay(60); assert.equal(h.get(b).state, 'queued');
  c.live.get(a.id)(); await until(() => c.live.has(b.id)); c.live.get(b.id)(); await h.done(b);
});

test('attachments use owned registered text and integrity checks, never renderer paths', async t => {
  const f = await fixture(t), artifactId = randomUUID(), text = 'verified attachment';
  const directory = f.storage.paths.conversation(f.app.id, f.conversation.id, 'attachments'); f.storage.paths.ensureDirectory(directory);
  const path = join(directory, artifactId); writeFileSync(path, text);
  f.storage.attachments.insert({ id: artifactId, appId: f.app.id, conversationId: f.conversation.id, displayName:'input.txt',
    relativePath: f.storage.paths.artifact(f.app.id, f.conversation.id, artifactId).replace('/artifacts/','/attachments/'), mimeType: 'text/plain', size: Buffer.byteLength(text),
    hash: createHash('sha256').update(text).digest('hex'), createdAt: Date.now() });
  const c = controlled(), h = harness(f, { open: c.open }), input = { ...h.input('read attachment'), attachmentIds: [artifactId] };
  const a = ok(h.scheduler.request(input)).run; await until(() => c.live.has(a.id));
  assert.match(c.starts[0].text, /verified attachment/); c.live.get(a.id)(); await h.done(a);
  const foreign = h.conversation();
  assert.equal(h.scheduler.request({ ...input, requestId: randomUUID(), conversationId: foreign.id }).ok, false);
  writeFileSync(path, 'tampered'); assert.equal(h.scheduler.request({ ...input, requestId: randomUUID() }).ok, false);
});

test('R09 final assistant and terminal event roll back together on storage failure; never report saved success', async t => {
  const f = await fixture(t), c = controlled(), h = harness(f, c), a = h.submit();
  await until(() => c.live.has(a.id));
  const append = f.storage.appendEvent.bind(f.storage);
  f.storage.appendEvent = (...args) => { if (args[2] === 'run.completed') throw Error('disk full'); return append(...args); };
  c.live.get(a.id)(); await until(() => h.scheduler.failed);
  assert.notEqual(h.get(a).state, 'succeeded');
  assert.equal(f.storage.messages.list({ appId: a.appId, conversationId: a.conversationId }).filter(m => m.role === 'assistant').length, 0);
  assert.equal(h.scheduler.request(h.input('new')).error.code, 'STORAGE_UNAVAILABLE');
  assert.equal(c.workers[0].closed, true); f.storage.appendEvent = append;
});

test('R01/R03/R10 actual Pi queue, handled result, TTL exact restoration and authoritative final message', { timeout: 45000 }, async t => {
  const f = await fixture(t), h = harness(f, { idleTtlMs: 80 });
  const start = performance.now(), a = h.submit('scheduler-memory-unique');
  t.diagnostic(`submit receipt ${(performance.now() - start).toFixed(1)}ms; Windows Node 24.19.0, SQLite FULL/WAL, local SSE fixture`);
  const b = h.submit('recall'); assert.equal((await h.done(a)).state, 'succeeded'); assert.equal((await h.done(b)).state, 'succeeded');
  const file = f.storage.conversations.get({ appId: f.app.id, id: f.conversation.id }).piSessionFile;
  await until(() => h.scheduler.workers.size === 0);
  const d = h.submit('recall'); assert.equal((await h.done(d)).state, 'succeeded');
  assert.equal(f.storage.conversations.get({ appId: f.app.id, id: f.conversation.id }).piSessionFile, file);
  assert.match(f.storage.messages.list({ appId: a.appId, conversationId: a.conversationId }).filter(m => m.runId === d.id && m.role === 'assistant')[0].content, /scheduler-memory-unique/);
  assert.equal((await h.done(h.submit('/aiappnest-handled'))).state, 'handled');
  assert.equal(f.requests.length, 3);
});

test('R05 actual Windows Pi startup cancellation never sends a prompt and subsequent queue continues', { timeout: 30000 }, async t => {
  const f = await fixture(t), h = harness(f), a = h.submit('never sent');
  await until(() => h.get(a).state === 'starting'); h.cancel(a);
  assert.equal((await h.done(a)).state, 'cancelled'); assert.equal(f.requests.length, 0);
  assert.equal((await h.done(h.submit('after startup cancellation'))).state, 'succeeded');
});

test('R11 an actual idle Worker crash is evicted before the next queued prompt restores its session', { timeout: 30000 }, async t => {
  const f = await fixture(t), h = harness(f);
  assert.equal((await h.done(h.submit('persist before crash'))).state, 'succeeded');
  const entry = h.scheduler.workers.get(f.conversation.id); entry.worker.child.kill();
  await until(() => h.scheduler.workers.size === 0);
  assert.equal((await h.done(h.submit('after idle crash'))).state, 'succeeded');
  assert.equal(f.requests.length, 2);
});

test('R06 actual Pi abort timeout retires Job and releases quota for next queued run', { timeout: 30000 }, async t => {
  const f = await fixture(t); let worker;
  const h = harness(f, { abortMs: 50, open: async (run, signal, onEvent) => {
    worker = await PiAdapter[f.storage.conversations.get({ appId: run.appId, id: run.conversationId }).piSessionFile ? 'restore' : 'start'](f.services, runtime, run.appId, run.conversationId, { signal, onEvent });
    const receive = worker.receive.bind(worker); worker.receive = value => { if (value.type === 'response' && value.command === 'abort') return; receive(value); }; return worker;
  } });
  const a = h.submit('slow'); await until(() => f.requests.length === 1);
  assert.equal(h.cancel(a).terminated, false); assert.equal((await h.done(a)).state, 'cancelled');
  assert.equal(worker.closed, true); const event = f.storage.events.list({ runId: a.id }).find(e => e.type === 'run.completed');
  assert.equal(event.payload.cancellation.forced, true);
  assert.equal((await h.done(h.submit('after forced close'))).state, 'succeeded');
});

test('R08 actual approval deny/timeout/revoke/host disconnect never writes and releases quota', { timeout: 60000 }, async t => {
  for (const action of ['deny','timeout','revoke','disconnect']) {
    const f = await fixture(t, { permissions: { mode: 'controlled-files', tools: ['write'] } });
    if (action === 'timeout') f.services.policy.options.approvalMs = 150;
    const grant = f.policyRequest({ operation: 'grants.create', resource: 'workspace', access: 'write', confirmation: 'always' }).grant;
    const h = harness(f), a = h.submit('tool:' + JSON.stringify({ name: 'platform_write', args: { grantId: grant.id, path: 'denied.txt', content: 'no' } }));
    await until(() => h.get(a).state === 'waiting_approval');
    const approval = f.policyRequest({ operation: 'approvals.list', runId: a.id }).approvals[0];
    if (action === 'deny') f.policyRequest({ operation: 'approvals.decide', runId: a.id, approvalId: approval.id, digest: approval.digest, decision: 'deny' });
    if (action === 'revoke') f.policyRequest({ operation: 'grants.revoke', grantId: grant.id, expectedVersion: grant.version });
    if (action === 'disconnect') await h.scheduler.close();
    assert.equal((await h.done(a)).state, 'cancelled'); assert.equal(existsSync(join(grant.root, 'denied.txt')), false);
    assert.equal(h.scheduler.active.size, 0); assert.equal(f.services.policy.runs.size, 0);
  }
});

test('R08 approval resumes only its exact call; subscription disconnect never approves another call', { timeout: 30000 }, async t => {
  const f = await fixture(t, { permissions: { mode: 'controlled-files', tools: ['write'] } });
  const grant = f.policyRequest({ operation: 'grants.create', resource: 'workspace', access: 'write', confirmation: 'always' }).grant;
  const h = harness(f), prompt = path => 'tool:' + JSON.stringify({ name: 'platform_write', args: { grantId: grant.id, path, content: 'allowed' } });
  const a = h.submit(prompt('first.txt'));
  await until(() => h.get(a).state === 'waiting_approval');
  const approval = f.policyRequest({ operation: 'approvals.list', runId: a.id }).approvals[0];
  f.policyRequest({ operation: 'approvals.decide', runId: a.id, approvalId: approval.id, digest: approval.digest, decision: 'allow' });
  assert.equal((await h.done(a)).state, 'succeeded'); assert.equal(readFileSync(join(grant.root, 'first.txt'), 'utf8'), 'allowed');
  const b = h.submit(prompt('second.txt'));
  await until(() => h.get(b).state === 'waiting_approval');
  const sub = ok(h.scheduler.request({ operation: 'subscribe', appId: b.appId, conversationId: b.conversationId, runId: b.id, afterSeq: 0 }));
  ok(h.scheduler.request({ operation: 'unsubscribe', subscriptionId: sub.subscriptionId }));
  await delay(100); assert.equal(existsSync(join(grant.root, 'second.txt')), false); assert.equal(h.get(b).state, 'waiting_approval');
  h.cancel(b); await h.done(b);
});

test('R06/R12 real Windows Job descendants exit on scheduler cancellation and shutdown; unrelated process survives', { timeout: 30000 }, async t => {
  const unrelated = spawn(runtime.node, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => unrelated.kill());
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const shutdown of [false,true]) {
    const f = await fixture(t); let pids = [], closed;
    const c = controlled();
    const h = harness(f, { ...c, open: async (...args) => {
      const worker = await c.open(...args);
      const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
      const job = spawn(runtime.nativeHost, ['job', String(process.pid), runtime.node, '-e', script], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      closed = new Promise(resolve => job.once('close', resolve)); let output = '';
      job.stdout.on('data', data => { output += data; if (output.includes('\n')) pids = JSON.parse(output.trim()); }); job.stderr.resume();
      worker.close = async () => { job.kill(); await closed; worker.closed = true; c.live.get(worker.current)?.('cancelled'); };
      worker.abort = worker.close; return worker;
    } });
    const a = h.submit(); await until(() => pids.length === 2 && c.live.has(a.id));
    if (shutdown) await h.scheduler.close(); else h.cancel(a);
    assert.equal((await h.done(a)).state, 'cancelled'); await closed; await until(() => pids.every(pid => !alive(pid)));
    assert.equal(alive(unrelated.pid), true);
  }
});

test('R03/R09/R12 production IPC submit/get/subscribe/next/unsubscribe/cancel and host shutdown persist states', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = new ServiceManager({ nodePath: runtime.node, entry: resolve('dist/service-host.cjs'), dataRoot: f.storage.paths.root });
  // Fixture cleanup runs first, so explicitly stop in finally before it closes storage.
  try {
    ok(await manager.start());
    const input = { operation: 'submit', appId: f.app.id, conversationId: f.conversation.id, revisionId: f.conversation.revisionId,
      requestId: randomUUID(), text: 'slow', attachmentIds: [] };
    const before = performance.now(), replies = await Promise.all([manager.runs(input), manager.runs(input)]);
    const a = ok(replies[0]).run; assert.equal(ok(replies[1]).run.id, a.id);
    t.diagnostic(`two IPC submit receipts ${(performance.now() - before).toFixed(1)}ms`);
    await until(() => f.requests.length === 1);
    let sub = ok(await manager.runs({ operation: 'subscribe', appId: a.appId, conversationId: a.conversationId, runId: a.id, afterSeq: 0 }));
    const start = performance.now(), receipt = ok(await manager.runs({ operation: 'cancel', appId: a.appId, conversationId: a.conversationId, runId: a.id }));
    t.diagnostic(`IPC cancel receipt ${(performance.now() - start).toFixed(1)}ms`);
    assert.equal(receipt.run.state, 'cancelling'); assert.equal(receipt.terminated, false);
    await until(() => finished(f.storage.runs.get({ appId: a.appId, id: a.id })));
    sub = ok(await manager.runs({ operation: 'next', subscriptionId: sub.subscriptionId, afterSeq: sub.afterSeq }));
    assert.equal(sub.terminal, true); assert.equal(sub.events.at(-1).type, 'run.completed');
    ok(await manager.runs({ operation: 'unsubscribe', subscriptionId: sub.subscriptionId }));
    const b = ok(await manager.runs({ ...input, requestId: randomUUID() })).run;
    await until(() => f.requests.length === 2);
    const queued = ok(await manager.runs({ ...input, requestId: randomUUID() })).run;
    await manager.stop();
    for (const run of [b,queued]) assert.equal(f.storage.runs.get({ appId: run.appId, id: run.id }).state, 'cancelled');
  } finally { await manager.stop(); }
});
