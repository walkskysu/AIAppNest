import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, release } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fixture, ok, runtime, RunScheduler } from './fixtures/engine-harness.mjs';

test('L09 record 100-app list and submit/cancel service receipt samples', async t => {
  const f = await fixture(t);
  for (let i = 1; i < 100; i++) ok(f.apps.request({ operation: 'create', metadata: { ...f.metadata, name: `性能样本 ${i}` } }));
  const scheduler = new RunScheduler(f.services, runtime); f.schedulers.push(scheduler);
  const samples = { list: [], submit: [], cancel: [] };
  const measure = (key, action, record) => {
    const start = performance.now(), value = ok(action());
    if (record) samples[key].push(performance.now() - start);
    return value;
  };
  for (let i = 0; i < 110; i++) {
    const record = i >= 10;
    const list = measure('list', () => f.apps.request({operation: 'list', query: '', archived: false, sort: 'recent', limit: 100, offset: 0}), record);
    assert.equal(list.total, 100);
    const input = {operation: 'submit', appId: f.app.id, conversationId: f.conversation.id, revisionId: f.conversation.revisionId, requestId: randomUUID(), text: 'benchmark', attachmentIds: []};
    const {run} = measure('submit', () => scheduler.request(input), record);
    measure('cancel', () => scheduler.request({operation: 'cancel', appId: run.appId, conversationId: run.conversationId, runId: run.id}), record);
  }
  assert.equal(f.requests.length, 0, 'receipt measurement never dispatches model work');
  const summary = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, {count: values.length, p95Ms: [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1], maxMs: Math.max(...values)}]));
  const report = {issue: 20, createdAt: new Date().toISOString(), kind: 'AUTOMATED_SERVICE_BENCHMARK',
    hardware: {cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem()/1024**3, windowsBuild: release(), node: process.version, storage: 'workspace filesystem; physical disk model and cache state unverified'},
    data: {apps: 100, warmup: 10, measuredIterations: 100},
    method: 'Synchronous production AppService list and RunScheduler submit/queued cancel including SQLite commit; nearest-rank P95 ceil(N*0.95)-1. No IPC, renderer paint, model latency or OS cold-cache claim.',
    samples, summary, targetMs: 200, serviceTargetMet: Object.values(summary).every(v => v.p95Ms < 200),
    pending: ['UI submission/stop receipt and paint','Packaged warm home startup','Default concurrency 2 process/memory and idle reclamation on acceptance hardware'], finalAcceptance: 'PENDING'};
  mkdirSync('release-output', {recursive: true});
  writeFileSync('release-output/service-benchmark.json', JSON.stringify(report, null, 2) + '\n');
  t.diagnostic(JSON.stringify(summary));
});
