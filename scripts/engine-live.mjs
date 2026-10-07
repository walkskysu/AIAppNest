// Explicit real-provider acceptance using an already published chat application and DPAPI credentials.
// No keys in argv/reports. Creates a fresh conversation; never replays a pre-existing user run.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const args = Object.fromEntries(process.argv.slice(2).map(value => { const split = value.indexOf('='); return [value.slice(2, split), value.slice(split + 1)]; }));
const report = { checkedAt: new Date().toISOString(), node: process.versions.node, pi: '0.73.1', gate: 'BLOCKED', code: 'MISSING_EXPLICIT_TEST_APP',
  streaming: false, restoredMessages: false, recall: false, cancellation: null };
let directory, storage, policy, worker, activeRun;
try {
  if (Object.keys(args).some(key => !['data-root','app'].includes(key)) || !isAbsolute(args['data-root'] ?? '')
    || !/^[0-9a-f-]{36}$/.test(args.app ?? '')) { process.exitCode = 2; }
  else {
    directory = mkdtempSync(resolve('.test-engine-live-'));
    const entry = join(directory, 'entry.mjs');
    await build({ entryPoints: ['tests/integration/fixtures/engine-entry.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' });
    const { Storage, AppService, ProviderService, CredentialService, PolicyService, PiAdapter, readEngineRuntime } = await import(pathToFileURL(entry));
    storage = new Storage(args['data-root']);
    const providers = new ProviderService(storage, new CredentialService(storage.paths, resolve('dist/credential-host.exe')));
    const apps = new AppService(storage, providers), app = storage.apps.get({ id: args.app });
    const revision = apps.readRevision(app.id, app.currentRevisionId);
    if (revision.snapshot.config.permissions.mode !== 'chat') throw Error('TEST_REQUIRES_CHAT_APP');
    const conversation = storage.createConversation(app.id, randomUUID(), 'Engine explicit live acceptance');
    policy = new PolicyService(storage, (a, r) => apps.readRevision(a, r));
    const services = { storage, apps, providers, policy }, runtime = readEngineRuntime(resolve('dist'));
    const options = { onEvent(event) { if (event.type === 'assistant.delta') report.streaming = true; } };
    const run = () => {
      const item = storage.createRun({ id: randomUUID(), appId: app.id, conversationId: conversation.id, requestId: randomUUID(), state: 'queued', phase: 'created',
        version: 1, createdAt: Date.now(), startedAt: null, endedAt: null, error: null, usage: null });
      storage.transitionRun(app.id, item.id, 1, 'starting'); storage.transitionRun(app.id, item.id, 2, 'running'); activeRun = { appId: app.id, id: item.id }; return item.id;
    };
    const finish = result => {
      const current = storage.runs.get({ appId: app.id, id: result.runId });
      let version = current.version;
      if (result.status === 'cancelled') { storage.transitionRun(app.id, result.runId, version++, 'cancelling'); }
      storage.transitionRun(app.id, result.runId, version, result.status, Date.now(), result.error ?? null, result.usage);
      activeRun = undefined;
    };
    worker = await PiAdapter.start(services, runtime, app.id, conversation.id, options);
    const marker = `memory-${randomUUID()}`;
    const first = await worker.prompt(run(), `Remember this exact marker for the next turn: ${marker}. Reply briefly.`); finish(first);
    if (first.status !== 'succeeded') throw Error('LIVE_MODEL_FAILED');
    const before = await worker.getMessages(), file = (await worker.getState()).sessionFile;
    await worker.close();
    worker = await PiAdapter.restore(services, runtime, app.id, conversation.id, options);
    report.restoredMessages = isDeepStrictEqual(before, await worker.getMessages()) && file === (await worker.getState()).sessionFile;
    const second = await worker.prompt(run(), 'Return only the exact marker I asked you to remember.'); finish(second);
    const messages = await worker.getMessages();
    report.recall = second.status === 'succeeded' && JSON.stringify(messages.at(-1)).includes(marker);
    // Cancel on the first streamed delta of a long response; a too-fast completed response is not a passing cancellation.
    let cancelling, requested = false;
    const original = options.onEvent;
    options.onEvent = event => {
      original(event);
      if (event.type === 'assistant.delta' && !requested) { requested = true; cancelling = worker.abort(3000); }
    };
    const third = await worker.prompt(run(), 'Write a detailed numbered list of 500 distinct short sentences.'); finish(third);
    if (cancelling) report.cancellation = await cancelling;
    if (report.streaming && report.restoredMessages && report.recall && third.status === 'cancelled'
      && report.cancellation?.requested && (report.cancellation.idle || report.cancellation.exited)) { report.gate = 'PASS'; report.code = 'SUCCESS'; }
    else { report.code = 'LIVE_ACCEPTANCE_INCOMPLETE'; process.exitCode = 2; }
  }
} catch { report.code = 'LIVE_ACCEPTANCE_FAILED'; process.exitCode = 2; }
finally {
  try { await worker?.close(true); } catch { report.gate = 'BLOCKED'; report.code = 'CLEANUP_FAILED'; process.exitCode = 2; }
  if (activeRun) {
    const run = storage.runs.get(activeRun);
    storage.transitionRun(activeRun.appId, run.id, run.version, 'interrupted', Date.now(), 'LIVE_ACCEPTANCE_FAILED');
  }
  policy?.close(); storage?.close();
  if (directory) writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
