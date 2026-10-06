import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { ServiceManager } from '../../dist/service-manager.cjs';
import { runLiveGate } from '../../scripts/provider-live-gate.mjs';

const bundle = mkdtempSync(resolve('.test-provider-bundle-'));
after(() => rmSync(bundle, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
await build({ entryPoints: ['tests/integration/fixtures/provider-entry.ts'], outfile: join(bundle, 'entry.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
const transportWorker = join(bundle, 'transport.cjs');
await build({ entryPoints: ['tests/integration/fixtures/provider-transport.ts'], outfile: transportWorker, bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
const { Storage, ProviderService, CredentialService, CredentialError, buildRuntime, testRuntime, migrate, migrations, providerSaveSchema, providerReplySchema } = createRequire(import.meta.url)(join(bundle, 'entry.cjs'));
const worker = resolve('dist/provider-probe.cjs');
const config = (overrides = {}) => ({ name: 'Local model', providerType: 'local-openai', endpoint: 'http://127.0.0.1:11434/v1', modelId: 'test-model', authMode: 'none', settings: { timeoutMs: 3000 }, ...overrides });
const save = (cfg = config(), credential = { action: 'clear' }, previous) => ({ operation: 'save', input: { config: cfg, credential, ...(previous ? { id: previous.id, expectedRevision: previous.revision } : {}) } });
const identity = p => ({ id: p.id, revision: p.revision });
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
class MemoryCredentials {
  values = new Map(); failCreate = false; failRemove = false;
  create(key) { if (this.failCreate) throw new CredentialError(); const ref = `secret:${randomUUID()}`; this.values.set(ref, key); return ref; }
  read(ref) { if (!this.values.has(ref)) throw new CredentialError(); return this.values.get(ref); }
  remove(ref) { if (this.failRemove) throw new CredentialError(); this.values.delete(ref); }
  collect(live) { let pending = false; for (const ref of this.values.keys()) if (!live.has(ref)) try { this.remove(ref); } catch { pending = true; } return pending; }
}
function fixture(t, probe = runtime => testRuntime(runtime, worker), credentials = new MemoryCredentials()) {
  const root = mkdtempSync(resolve('.test-provider-中文 空格-'));
  const storage = new Storage(root);
  const service = new ProviderService(storage, credentials, probe);
  t.after(() => { storage.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, storage, service, credentials };
}
async function server(t, handler) {
  const requests = [];
  const instance = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, originalUrl: req.headers['x-test-original-url'], authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    handler(req, res);
  });
  instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.close(resolve); instance.closeAllConnections(); }));
  return { endpoint: `http://127.0.0.1:${instance.address().port}/v1`, requests };
}
function success(_req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

test('P01 strict supported configuration, manual model IDs, endpoint and settings allowlist', () => {
  assert.ok(providerSaveSchema.safeParse(save().input).success);
  for (const bad of [
    { endpoint: '' }, { endpoint: 'not-a-url' }, { endpoint: 'http://[broken/v1' },
    { endpoint: 'https://user:password@api.openai.com/v1' }, { endpoint: 'http://127.0.0.1/v1?key=secret' },
    { endpoint: 'http://127.0.0.1/v1#secret' }, { endpoint: 'http://192.168.1.2/v1' }, { endpoint: 'file:///v1' },
    { endpoint: 'http://127.0.0.1/v1/key' }, { providerType: 'unknown' }, { settings: { timeoutMs: 3000, headers: { Authorization: 'x' } } },
    { settings: { timeoutMs: 60001 } }, { modelId: '' }, { env: { OPENAI_API_KEY: 'x' } },
  ]) assert.equal(providerSaveSchema.safeParse(save(config(bad)).input).success, false);
});

test('DeepSeek official configuration uses the existing credential boundary without a live probe', async t => {
  let calls = 0;
  const { service } = fixture(t, async () => { calls++; return 'SUCCESS'; });
  const deepseek = config({ providerType: 'deepseek', endpoint: 'https://api.deepseek.com', modelId: 'deepseek-flash', authMode: 'api-key' });
  for (const endpoint of ['https://api.deepseek.com', 'https://api.deepseek.com/v1']) {
    const p = ok(await service.request(save({ ...deepseek, endpoint }, { action: 'replace', key: 'controlled-deepseek-test-key' }))).profile;
    const runtime = service.runtime(identity(p)); assert.equal(runtime.model.baseUrl, endpoint); assert.equal(runtime.model.api, 'openai-completions');
    assert.equal(runtime.model.id, 'deepseek-flash'); assert.equal(runtime.apiKey, 'controlled-deepseek-test-key');
  }
  for (const bad of [{ endpoint: 'https://api.deepseek.com.evil/v1' }, { endpoint: 'http://api.deepseek.com/v1' },
    { endpoint: 'https://api.deepseek.com/v1?key=secret' }, { endpoint: 'https://api.deepseek.com/evil' }, { authMode: 'none' }])
    assert.equal(providerSaveSchema.safeParse(save({ ...deepseek, ...bad }, { action: 'replace', key: 'controlled-key' }).input).success, false);
  assert.equal(calls, 0);
});

test('P02 save/list are redacted, persistent, and never call a model', async t => {
  let calls = 0;
  const { service, storage, root } = fixture(t, async () => { calls++; return 'SUCCESS'; });
  const key = 'test-only-sensitive-marker-P02';
  const p = ok(await service.request(save(config({ authMode: 'api-key' }), { action: 'replace', key }))).profile;
  assert.equal(p.hasCredential, true); assert.equal(p.revision, 1);
  const listed = ok(await service.request({ operation: 'list' }));
  assert.ok(providerReplySchema.safeParse(listed).success);
  assert.doesNotMatch(JSON.stringify(listed), /secretRef|test-only-sensitive-marker/);
  assert.equal(calls, 0); storage.close();
  const reopened = new Storage(root);
  try { assert.equal(reopened.providers.get({ id: p.id }).name, p.name); } finally { reopened.close(); }
  for (const filename of readdirSync(join(root, 'data'))) assert.equal(readFileSync(join(root, 'data', filename)).includes(Buffer.from(key)), false);
});

test('P03 migration preserves v1 references and checksum; legacy rows need explicit model setup', t => {
  const { root } = fixture(t);
  const file = join(root, 'legacy.db'); const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON');
  try {
  migrate(db, migrations.slice(0, 1));
  const ref = `secret:${randomUUID()}`, id = randomUUID();
  db.prepare('INSERT INTO provider_profiles VALUES(?,?,?,?,?,?)').run(id, 'legacy', 'http://127.0.0.1/v1', ref, '{"timeoutMs":3000}', 42);
  const checksum = db.prepare('SELECT checksum FROM schema_migrations').get().checksum;
  migrate(db); migrate(db);
  const row = db.prepare('SELECT * FROM provider_profiles').get();
  assert.equal(row.secretRef, ref); assert.equal(row.updatedAt, 42); assert.equal(row.modelId, ''); assert.equal(row.authMode, 'api-key');
  assert.equal(db.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get().checksum, checksum);
  assert.equal(checksum, createHash('sha256').update(migrations[0].sql).digest('hex'));
  } finally { db.close(); }
});

test('P04 revision conflicts preserve both configuration and credentials', async t => {
  const { service, credentials } = fixture(t);
  const p = ok(await service.request(save())).profile;
  const changed = ok(await service.request(save(config({ name: 'New name' }), { action: 'clear' }, p))).profile;
  assert.equal(changed.revision, 2);
  const stale = await service.request(save(config({ authMode: 'api-key' }), { action: 'replace', key: 'stale-test-key' }, p));
  assert.equal(stale.error.code, 'VERSION_CONFLICT'); assert.equal(credentials.values.size, 0);
});

test('P05 key keep, replacement, no-auth clearing and endpoint rebinding', async t => {
  const { service, credentials } = fixture(t);
  const cfg = config({ authMode: 'api-key' });
  let p = ok(await service.request(save(cfg, { action: 'replace', key: 'key-one-test' }))).profile;
  const old = [...credentials.values.keys()][0];
  p = ok(await service.request(save(cfg, { action: 'keep' }, p))).profile;
  assert.ok(credentials.values.has(old));
  assert.equal((await service.request(save({ ...cfg, endpoint: 'http://127.0.0.1:1111/v1' }, { action: 'keep' }, p))).error.code, 'INVALID_INPUT');
  p = ok(await service.request(save(cfg, { action: 'replace', key: 'key-two-test' }, p))).profile;
  assert.equal(credentials.values.has(old), false); assert.equal(credentials.values.size, 1);
  p = ok(await service.request(save(config(), { action: 'clear' }, p))).profile;
  assert.equal(p.hasCredential, false); assert.equal(credentials.values.size, 0);
});

test('P06 credential write failure leaves previous revision usable', async t => {
  const { service, credentials } = fixture(t);
  const cfg = config({ authMode: 'api-key' });
  const p = ok(await service.request(save(cfg, { action: 'replace', key: 'old-test-key' }))).profile;
  credentials.failCreate = true;
  assert.equal((await service.request(save(cfg, { action: 'replace', key: 'new-test-key' }, p))).error.code, 'CREDENTIAL_UNAVAILABLE');
  assert.equal(service.runtime(identity(p)).apiKey, 'old-test-key');
});

test('P07 DB failure compensates staged credential; startup collects failed cleanup and crash orphans', async t => {
  const { service, storage, credentials } = fixture(t);
  const original = storage.saveProvider.bind(storage);
  storage.saveProvider = () => { throw new Error('unsafe database diagnostics'); };
  const attempt = () => service.request(save(config({ authMode: 'api-key' }), { action: 'replace', key: 'new-test-key' }));
  assert.equal((await attempt()).error.code, 'STORAGE_UNAVAILABLE'); assert.equal(credentials.values.size, 0);
  credentials.failRemove = true; await attempt(); assert.equal(credentials.values.size, 1);
  storage.saveProvider = original; credentials.failRemove = false;
  new ProviderService(storage, credentials); assert.equal(credentials.values.size, 0);
});

test('P08 committed replacement survives cleanup failure; referenced profile cannot be deleted', async t => {
  const { service, storage, credentials } = fixture(t);
  const cfg = config({ authMode: 'api-key' });
  const p = ok(await service.request(save(cfg, { action: 'replace', key: 'old-test-key' }))).profile;
  credentials.failRemove = true;
  const result = ok(await service.request(save(cfg, { action: 'replace', key: 'new-test-key' }, p)));
  assert.equal(result.cleanupPending, true); assert.equal(credentials.values.size, 2);
  assert.equal(service.runtime(identity(result.profile)).apiKey, 'new-test-key');
  const appId = randomUUID(), now = Date.now();
  storage.apps.insert({ id: appId, name: 'App', description: '', icon: null, status: 'draft', currentRevisionId: null, version: 1, createdAt: now, updatedAt: now });
  storage.publishRevision({ id: randomUUID(), appId, revision: 1, providerProfileId: p.id, config: { schemaVersion: 1, modelId: cfg.modelId, memory: { enabled: false, maxItems: 0, tokenBudget: 0 }, permissions: { mode: 'chat', shell: false } }, roleText: '', runtimeVersion: '0.73.1', createdAt: now }, [], 1);
  assert.equal((await service.request({ operation: 'delete', input: identity(result.profile) })).error.code, 'PROVIDER_IN_USE');
  credentials.failRemove = false; new ProviderService(storage, credentials); assert.equal(credentials.values.size, 1);
  const disposable = ok(await service.request(save())).profile;
  ok(await service.request({ operation: 'delete', input: identity(disposable) }));
  assert.equal((await service.request({ operation: 'test', input: identity(disposable) })).error.code, 'NOT_FOUND');
});

test('P09 real Windows CurrentUser DPAPI ciphertext roundtrip, restart, corruption, missing ref and model injection', { skip: process.platform !== 'win32' }, async t => {
  const { storage, root } = fixture(t);
  const helper = resolve('dist/credential-host.exe');
  const vault = new CredentialService(storage.paths, helper);
  const key = 'non-sensitive-DPAPI-provider-marker';
  const ref = vault.create(key);
  const file = join(root, 'credentials', `${ref.slice(7)}.bin`);
  assert.equal(readFileSync(file).includes(Buffer.from(key)), false);
  assert.equal(new CredentialService(storage.paths, helper).read(ref), key);
  writeFileSync(file, 'corrupted'); assert.throws(() => vault.read(ref), { code: 'CREDENTIAL_UNAVAILABLE' });
  vault.remove(ref); assert.throws(() => vault.read(ref), { code: 'CREDENTIAL_UNAVAILABLE' });
  assert.throws(() => vault.read('secret:../../escape'), { code: 'CREDENTIAL_UNAVAILABLE' });
  const mock = await server(t, success);
  const service = new ProviderService(storage, vault, runtime => testRuntime(runtime, worker));
  const p = ok(await service.request(save(config({ endpoint: mock.endpoint, authMode: 'api-key' }), { action: 'replace', key }))).profile;
  assert.equal(ok(await service.request({ operation: 'test', input: identity(p) })).result.code, 'SUCCESS');
  assert.equal(mock.requests[0].authorization, `Bearer ${key}`);
  for (const area of ['data', 'credentials']) for (const name of readdirSync(join(root, area))) {
    assert.equal(readFileSync(join(root, area, name)).includes(Buffer.from(key)), false);
  }
  ok(await service.request({ operation: 'delete', input: identity(p) }));
  assert.deepEqual(readdirSync(join(root, 'credentials')), []);
});

test('D05 DeepSeek uses product DPAPI and keeps test keys out of DTO, logs, config, database and ciphertext', { skip: process.platform !== 'win32' }, async t => {
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const originalSpawn = childProcess.spawnSync;
  const commandLines = [];
  childProcess.spawnSync = (file, args, options) => { commandLines.push([file, ...args]); return originalSpawn(file, args, options); };
  t.after(() => { childProcess.spawnSync = originalSpawn; });
  const mock = await server(t, success);
  const { storage, root } = fixture(t);
  const key = 'non-sensitive-deepseek-DPAPI-marker';
  const vault = new CredentialService(storage.paths, resolve('dist/credential-host.exe'));
  const service = new ProviderService(storage, vault, mockProbe(mock));
  const p = ok(await service.request(save(deepseek(), { action: 'replace', key }))).profile;
  const restarted = new ProviderService(storage, new CredentialService(storage.paths, resolve('dist/credential-host.exe')), mockProbe(mock));
  const result = ok(await restarted.request({ operation: 'test', input: identity(p) }));
  assert.equal(result.result.code, 'SUCCESS');
  assert.equal(mock.requests[0].authorization, `Bearer ${key}`);
  assert.doesNotMatch(JSON.stringify([p, result, ok(await restarted.request({ operation: 'list' }))]), /non-sensitive-deepseek-DPAPI-marker|secretRef/);
  const scan = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else assert.equal(readFileSync(path).includes(Buffer.from(key)), false, path);
    }
  };
  scan(root);
  assert.ok(commandLines.length >= 2);
  assert.equal(JSON.stringify(commandLines).includes(key), false);
});

test('P10 explicit probe executes Pi OpenAI text generation with a fixed request and no local Authorization', async t => {
  const mock = await server(t, success);
  const { service } = fixture(t);
  const p = ok(await service.request(save(config({ endpoint: mock.endpoint })))).profile;
  assert.equal(mock.requests.length, 0);
  const result = ok(await service.request({ operation: 'test', input: identity(p) })).result;
  assert.equal(result.code, 'SUCCESS'); assert.equal(result.stale, false); assert.equal(result.revision, p.revision);
  assert.equal(mock.requests.length, 1); const request = mock.requests[0];
  assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.authorization, undefined);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
  assert.equal(request.body.tools, undefined); assert.equal(request.body.max_tokens, 16);
});

test('P11 auth, model, rate-limit, server errors are classified with no retry or echoed secrets', async t => {
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [404, 'MODEL_NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'NETWORK_ERROR']]) {
    const mock = await server(t, (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"error":{"message":"sensitive-test-key echoed"}}'); });
    const { service } = fixture(t);
    const p = ok(await service.request(save(config({ endpoint: mock.endpoint, authMode: 'api-key' }), { action: 'replace', key: 'sensitive-test-key' }))).profile;
    const result = ok(await service.request({ operation: 'test', input: identity(p) }));
    assert.equal(result.result.code, code); assert.equal(mock.requests.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /sensitive-test-key|errorMessage|stack/);
  }
});

test('P12 empty, malformed, truncated, oversized and redirected responses cannot pass', async t => {
  const destination = await server(t, success);
  for (const handler of [
    (_req, res) => res.end('{}'),
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: malformed\n\n'); },
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'); },
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + 'a'.repeat(66000) + '\n\n'); },
    (_req, res) => { res.writeHead(307, { location: `${destination.endpoint}/chat/completions` }); res.end(); },
  ]) {
    const mock = await server(t, handler);
    const code = await testRuntime(buildRuntime(config({ endpoint: mock.endpoint }), undefined), worker);
    assert.notEqual(code, 'SUCCESS');
  }
  assert.equal(destination.requests.length, 0);
});

test('P13 hanging stream times out and Worker is terminated', async t => {
  const mock = await server(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); });
  const start = Date.now();
  assert.equal(await testRuntime(buildRuntime(config({ endpoint: mock.endpoint, settings: { timeoutMs: 500 } }), undefined), worker), 'TIMEOUT');
  assert.ok(Date.now() - start < 3000);
});

test('P14 edits during a test mark results stale; missing credentials fail closed', async t => {
  let finish;
  const { service, credentials } = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const cfg = config({ authMode: 'api-key' });
  let p = ok(await service.request(save(cfg, { action: 'replace', key: 'test-snapshot-key' }))).profile;
  const pending = service.request({ operation: 'test', input: identity(p) });
  p = ok(await service.request(save(cfg, { action: 'keep' }, p))).profile;
  finish('SUCCESS'); assert.equal(ok(await pending).result.stale, true);
  credentials.values.clear();
  assert.equal(ok(await service.request({ operation: 'test', input: identity(p) })).result.code, 'CREDENTIAL_UNAVAILABLE');
});

test('P15 concurrent models isolate keys and allowlisted environments; four-test limit', async t => {
  const before = { ...process.env };
  const mock = await server(t, success);
  const runtimes = ['A', 'B'].map(letter => buildRuntime(config({ endpoint: mock.endpoint, modelId: `model-${letter}`, authMode: 'api-key' }), `test-key-${letter}`, { SystemRoot: process.env.SystemRoot, OTHER_KEY: 'must-not-inherit', NODE_OPTIONS: 'bad', OPENAI_API_KEY: 'ambient' }));
  assert.deepEqual(await Promise.all(runtimes.map(runtime => testRuntime(runtime, worker))), ['SUCCESS', 'SUCCESS']);
  for (const request of mock.requests) assert.equal(request.authorization, `Bearer test-key-${request.body.model.at(-1)}`);
  assert.equal(runtimes[0].env.OTHER_KEY, undefined); assert.equal(runtimes[0].env.NODE_OPTIONS, undefined);
  assert.equal(runtimes[0].env.OPENAI_API_KEY, undefined); assert.notEqual(runtimes[0].env, runtimes[1].env);
  assert.deepEqual({ ...process.env }, before);
  const finish = []; const { service } = fixture(t, () => new Promise(resolve => finish.push(resolve)));
  const p = ok(await service.request(save())).profile;
  const calls = Array.from({ length: 4 }, () => service.request({ operation: 'test', input: identity(p) }));
  assert.equal((await service.request({ operation: 'test', input: identity(p) })).error.code, 'BUSY');
  finish.forEach(resolve => resolve('SUCCESS')); await Promise.all(calls);
});

test('P16 production sidecar IPC validates inputs and exposes no credential-read route', async t => {
  const root = mkdtempSync(resolve('.test-provider-ipc-'));
  const manager = new ServiceManager({ nodePath: process.execPath, entry: resolve('dist/service-host.cjs'), dataRoot: root });
  t.after(async () => { await manager.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  ok(await manager.start());
  const invalid = await manager.providers(save(config({ endpoint: 'invalid-test-secret' })));
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  assert.doesNotMatch(JSON.stringify(invalid), /invalid-test-secret|stack/);
  assert.equal(manager.snapshot().phase, 'ready');
  assert.equal((await manager.providers({ operation: 'readCredential', ref: 'anything' })).error.code, 'INVALID_INPUT');
  assert.equal((await manager.providers({ ...save(), secretRef: 'fake' })).error.code, 'INVALID_INPUT');
  const mock = await server(t, success);
  const p = ok(await manager.providers(save(config({ endpoint: mock.endpoint })))).profile;
  assert.equal(ok(await manager.providers({ operation: 'test', input: identity(p) })).result.code, 'SUCCESS');
  assert.equal(ok(await manager.providers({ operation: 'list' })).profiles.length, 1);
});

test('P18 real-model acceptance gate refuses absent explicit local profiles', () => {
  const result = spawnSync(process.execPath, ['scripts/provider-live.mjs'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gate, 'BLOCKED'); assert.equal(report.code, 'MISSING_EXPLICIT_PROFILES');
  assert.equal(report.cloud, null); assert.equal(report.local, null);
  assert.equal(result.stderr, '');
});

const deepseek = (overrides = {}) => config({ name: 'DeepSeek 官方', providerType: 'deepseek', endpoint: 'https://api.deepseek.com', modelId: 'deepseek-flash', authMode: 'api-key', ...overrides });
const mockProbe = mock => runtime => testRuntime({ ...runtime, env: { ...runtime.env, PROVIDER_TEST_ORIGIN: new URL(mock.endpoint).origin } }, transportWorker);

test('D01/D06 DeepSeek strict endpoint, persistence, revision and credential rebinding', async t => {
  for (const endpoint of ['https://api.deepseek.com', 'https://api.deepseek.com/']) {
    const parsed = providerSaveSchema.parse(save(deepseek({ endpoint }), { action: 'replace', key: 'test-key' }).input);
    assert.equal(parsed.config.endpoint, 'https://api.deepseek.com');
  }
  for (const bad of [
    { endpoint: 'https://api.deepseek.com/v1' }, { endpoint: 'https://api.deepseek.com/chat/completions' },
    { endpoint: 'https://api.deepseek.com/v1/chat/completions' }, { endpoint: 'http://api.deepseek.com' },
    { endpoint: 'https://api.deepseek.com:444' }, { endpoint: 'https://api.deepseek.com.evil.test' },
    { endpoint: 'https://key@api.deepseek.com' }, { endpoint: 'https://api.deepseek.com?key=secret' },
    { endpoint: 'https://api.deepseek.com/#secret' }, { endpoint: 'http://127.0.0.1/v1' },
    { authMode: 'none' }, { thinking: { type: 'enabled' } },
  ]) assert.equal(providerSaveSchema.safeParse(save(deepseek(bad)).input).success, false);
  let calls = 0;
  const { service, credentials, storage, root } = fixture(t, async () => { calls++; return 'SUCCESS'; });
  const original = ok(await service.request(save(config({ providerType: 'openai', endpoint: 'https://api.openai.com/v1', authMode: 'api-key' }), { action: 'replace', key: 'openai-test-marker' }))).profile;
  assert.equal((await service.request(save(deepseek(), { action: 'keep' }, original))).error.code, 'INVALID_INPUT');
  assert.equal(service.runtime(identity(original)).apiKey, 'openai-test-marker');
  const changed = ok(await service.request(save(deepseek(), { action: 'replace', key: 'deepseek-test-marker' }, original))).profile;
  assert.equal(changed.revision, 2);
  assert.equal((await service.request({ operation: 'test', input: identity(original) })).error.code, 'VERSION_CONFLICT');
  assert.equal(calls, 0);
  assert.deepEqual([...credentials.values.values()], ['deepseek-test-marker']);
  storage.close();
  const reopened = new Storage(root);
  try {
    const restarted = new ProviderService(reopened, credentials);
    assert.equal(restarted.runtime(identity(changed)).model.baseUrl, 'https://api.deepseek.com');
    assert.equal(restarted.runtime(identity(changed)).model.id, 'deepseek-flash');
    const dto = ok(await restarted.request({ operation: 'list' }));
    assert.ok(providerReplySchema.safeParse(dto).success);
    assert.doesNotMatch(JSON.stringify(dto), /secretRef|test-marker/);
  } finally { reopened.close(); }
  for (const filename of readdirSync(join(root, 'data'))) assert.doesNotMatch(readFileSync(join(root, 'data', filename)).toString(), /openai-test-marker|deepseek-test-marker/);
});

test('D02/D03/D08 official runtime path and parallel providers keep payloads and keys isolated', async t => {
  const before = { ...process.env };
  const mock = await server(t, success);
  const { service } = fixture(t, mockProbe(mock));
  const profiles = [];
  for (const cfg of [deepseek(), config({ providerType: 'openai', endpoint: 'https://api.openai.com/v1', authMode: 'api-key' }), config({ endpoint: mock.endpoint, authMode: 'api-key' })]) {
    profiles.push(ok(await service.request(save(cfg, { action: 'replace', key: `test-${cfg.providerType}-key` }))).profile);
  }
  assert.equal(mock.requests.length, 0);
  const results = await Promise.all(profiles.map(p => service.request({ operation: 'test', input: identity(p) })));
  assert.deepEqual(results.map(r => ok(r).result.code), ['SUCCESS', 'SUCCESS', 'SUCCESS']);
  for (const p of profiles) {
    const req = mock.requests.find(r => r.authorization === `Bearer test-${p.providerType}-key`);
    assert.equal(req.originalUrl, `${p.endpoint}/chat/completions`);
    assert.equal(req.url, p.providerType === 'deepseek' ? '/chat/completions' : '/v1/chat/completions');
    assert.equal(req.body.model, p.modelId); assert.equal(req.body.stream, true);
    assert.deepEqual(req.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
    if (p.providerType === 'deepseek') {
      assert.deepEqual(req.body, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true,
        stream_options: { include_usage: true }, max_tokens: 128, thinking: { type: 'disabled' } });
    } else assert.equal(req.body.thinking, undefined);
  }
  assert.deepEqual({ ...process.env }, before);
  assert.doesNotMatch(JSON.stringify(results), /test-.*-key|secretRef|Bearer/);
});

test('D04/D07 DeepSeek failures, incomplete SSE, redirects and timeout fail closed without retries', async t => {
  const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const end = 'data: [DONE]\n\n';
  const destination = await server(t, success);
  const cases = [
    ...[[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [402, 'QUOTA_EXCEEDED'], [404, 'MODEL_NOT_FOUND'], [429, 'RATE_LIMITED'], [500, 'NETWORK_ERROR'], [503, 'NETWORK_ERROR'], [400, 'PROTOCOL_ERROR']]
      .map(([status, code]) => [code, (_req, res) => { res.writeHead(status); res.end('deepseek-error-test-key'); }]),
    ...[
      ['', 'PROTOCOL_ERROR'],
      [event({}, 'stop') + end, 'PROTOCOL_ERROR'],
      [event({ reasoning_content: 'thinking only' }, 'stop') + end, 'PROTOCOL_ERROR'],
      [event({ content: 'partial' }, 'length') + end, 'INCOMPLETE_RESPONSE'],
      [event({ content: 'partial' }) + end, 'PROTOCOL_ERROR'],
      [event({ content: 'OK' }, 'stop'), 'PROTOCOL_ERROR'],
      [event({ content: 'OK' }, 'stop') + 'data: broken\n\n' + end, 'PROTOCOL_ERROR'],
      [event({ content: 'OK' }, 'unknown') + end, 'PROTOCOL_ERROR'],
      [event({ content: 'OK' }, 'stop') + event({}, 'length') + end, 'PROTOCOL_ERROR'],
      [event({ content: 'OK' }, 'stop') + 'data: {"error":{"message":"deepseek-error-test-key"}}\n\n' + end, 'PROTOCOL_ERROR'],
      [event({ content: 'x'.repeat(66000) }, 'stop') + end, 'PROTOCOL_ERROR'],
    ].map(([body, code]) => [code, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); }]),
    ['NETWORK_ERROR', (_req, res) => { res.writeHead(307, { location: `${destination.endpoint}/chat/completions` }); res.end(); }],
    ['TIMEOUT', (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); }],
  ];
  for (const [code, handler] of cases) {
    const mock = await server(t, handler);
    const { service } = fixture(t, mockProbe(mock));
    const p = ok(await service.request(save(deepseek({ settings: { timeoutMs: code === 'TIMEOUT' ? 1000 : 3000 } }), { action: 'replace', key: 'deepseek-error-test-key' }))).profile;
    const start = Date.now();
    const result = ok(await service.request({ operation: 'test', input: identity(p) }));
    assert.equal(result.result.code, code);
    assert.equal(mock.requests.length, 1);
    assert.ok(Date.now() - start < 4000);
    assert.doesNotMatch(JSON.stringify(result), /deepseek-error-test-key|stack|Bearer/);
  }
  assert.equal(destination.requests.length, 0);
});

test('D03 fragmented UTF-8 SSE, CRLF, keepalive and usage-only trailer complete normally', async t => {
  const mock = await server(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(': keepalive\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\r\n\r\ndata: [DONE]\r\n\r\n');
    for (const byte of bytes) { res.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); }
    res.end();
  });
  const { service } = fixture(t, mockProbe(mock));
  const p = ok(await service.request(save(deepseek(), { action: 'replace', key: 'test-fragment-key' }))).profile;
  assert.equal(ok(await service.request({ operation: 'test', input: identity(p) })).result.code, 'SUCCESS');
});

test('D09 live gate accepts DeepSeek, requires both profiles and exact revisions, never claims partial PASS', async t => {
  const mock = await server(t, success);
  const { service, credentials, storage } = fixture(t, mockProbe(mock));
  let cloud = ok(await service.request(save(deepseek(), { action: 'replace', key: 'live-gate-test-key' }))).profile;
  const local = ok(await service.request(save(config({ endpoint: mock.endpoint })))).profile;
  const report = await runLiveGate(service, cloud, local);
  assert.equal(report.gate, 'PASS'); // Mock-only gate logic, not live acceptance evidence.
  assert.equal(report.cloud.providerType, 'deepseek'); assert.equal(report.local.providerType, 'local-openai');
  assert.equal(report.cloud.mode, 'non-thinking-text-sse');
  assert.ok(report.cloud.testedAt); assert.ok(report.cloud.durationMs >= 0);
  assert.doesNotMatch(JSON.stringify(report), /secretRef|live-gate-test-key|https:|Bearer/);
  const count = mock.requests.length;
  await assert.rejects(runLiveGate(service, cloud, cloud));
  const stale = await runLiveGate(service, cloud, { ...local, revision: local.revision + 1 });
  assert.equal(stale.gate, 'BLOCKED'); assert.equal(stale.local.code, 'VERSION_CONFLICT');
  credentials.values.clear();
  const missing = await runLiveGate(service, cloud, local);
  assert.equal(missing.gate, 'BLOCKED'); assert.equal(missing.cloud.code, 'CREDENTIAL_UNAVAILABLE');
  assert.equal(missing.cloud.providerType, 'deepseek'); assert.equal(missing.local.code, 'NOT_TESTED');
  assert.equal(mock.requests.length, count);
  cloud = ok(await service.request(save(deepseek(), { action: 'replace', key: 'live-gate-test-key' }, cloud))).profile;
  const failing = await server(t, (_req, res) => { res.writeHead(503); res.end(); });
  const brokenLocal = ok(await service.request(save(config({ endpoint: failing.endpoint })))).profile;
  // Route each provider independently: cloud mock succeeds, local mock fails.
  const mixedService = new ProviderService(storage, credentials, runtime => runtime.providerType === 'deepseek' ? mockProbe(mock)(runtime) : testRuntime(runtime, worker));
  const partial = await runLiveGate(mixedService, cloud, brokenLocal);
  assert.equal(partial.cloud.code, 'SUCCESS'); assert.equal(partial.local.code, 'NETWORK_ERROR');
  assert.equal(partial.gate, 'BLOCKED');
  for (const args of [[], [`--data-root=${storage.paths.root}`, `--cloud=${cloud.id}`], [`--data-root=${storage.paths.root}`, '--cloud=invalid', `--local=${local.id}`]]) {
    const result = spawnSync(process.execPath, ['scripts/provider-live.mjs', ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).code, 'MISSING_EXPLICIT_PROFILES');
    assert.equal(result.stderr, '');
  }
});
