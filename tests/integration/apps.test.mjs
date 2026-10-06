import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServiceManager } from '../../dist/service-manager.cjs';

const bundle = mkdtempSync(resolve('.test-apps-bundle-'));
after(() => rmSync(bundle, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
await build({ entryPoints: ['tests/integration/fixtures/apps-entry.ts'], outfile: join(bundle, 'entry.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
const { Storage, AppService, ProviderService, CredentialError, newAppConfig, appReplySchema } = createRequire(import.meta.url)(join(bundle, 'entry.cjs'));
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(appReplySchema.safeParse(result.value).success); return result.value; };
const metadata = (name = '应用', overrides = {}) => ({ name, description: '简介', icon: 'book', category: '写作', favorite: false, ...overrides });
const list = (overrides = {}) => ({ operation: 'list', query: '', archived: false, sort: 'recent', limit: 12, offset: 0, ...overrides });
const ident = app => ({ appId: app.id, expectedVersion: app.version });
const cfg = (overrides = {}) => ({ name: 'Controlled profile — not live tested', providerType: 'deepseek', endpoint: 'https://api.deepseek.com', modelId: 'deepseek-flash', authMode: 'api-key', settings: { timeoutMs: 3000 }, ...overrides });
class Vault {
  values = new Map();
  create(key) { const ref = `secret:${randomUUID()}`; this.values.set(ref, key); return ref; }
  read(ref) { if (!this.values.has(ref)) throw new CredentialError(); return this.values.get(ref); }
  remove(ref) { this.values.delete(ref); }
  collect(live) { for (const ref of this.values.keys()) if (!live.has(ref)) this.values.delete(ref); return false; }
}
function fixture(t, fault) {
  const root = mkdtempSync(resolve('.test-apps-中文 空格-')), storage = new Storage(root), vault = new Vault();
  let calls = 0;
  const providers = new ProviderService(storage, vault, async () => { calls++; throw new Error('No model calls permitted'); });
  const service = new AppService(storage, providers, fault);
  t.after(() => { assert.equal(calls, 0); storage.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, storage, vault, providers, service };
}
const create = (service, name) => ok(service.request({ operation: 'create', metadata: metadata(name) })).app;
const get = (service, app) => ok(service.request({ operation: 'get', appId: app.id })).app;
const edit = (service, app, draft = app.draft, meta = metadata(app.name)) => ok(service.request({ operation: 'update', ...ident(app), draft, metadata: meta })).app;
const publish = (service, app) => ok(service.request({ operation: 'publish', ...ident(app) })).app;
async function provider(providers, previous, config = cfg(), key = 'controlled-test-key') {
  const result = await providers.request({ operation: 'save', input: { config, credential: { action: 'replace', key },
    ...(previous ? { id: previous.id, expectedRevision: previous.revision } : {}) } });
  assert.equal(result.ok, true, JSON.stringify(result)); return result.value.profile;
}
async function configured(f, name = '写作助手') {
  const p = await provider(f.providers), app = create(f.service, name);
  return { app: edit(f.service, app, { ...app.draft, role: '帮助写作', model: { providerProfileId: p.id, expectedRevision: p.revision, temperature: 0.5, maxOutputTokens: 1024 } }), p };
}

test('A01 application metadata, literal search, pagination, favorites/recent and restart persistence', t => {
  const f = fixture(t), a = create(f.service, '甲应用'), b = create(f.service, '乙应用');
  const edited = edit(f.service, a, a.draft, metadata('新名字', { favorite: true, description: '中文搜索描述' }));
  assert.equal(ok(f.service.request(list({ query: '中文搜索' }))).apps[0].id, a.id);
  assert.equal(ok(f.service.request(list({ query: "' OR 1=1--" }))).total, 0);
  assert.equal(ok(f.service.request(list({ sort: 'favorite', limit: 1 }))).apps[0].id, a.id);
  assert.equal(ok(f.service.request(list({ sort: 'favorite', limit: 1, offset: 1 }))).apps[0].id, b.id);
  ok(f.service.request({ operation: 'open', appId: a.id }));
  assert.equal(ok(f.service.request(list())).apps[0].id, a.id);
  assert.equal(get(f.service, a).version, edited.version, 'opening must not stale the draft');
  f.storage.close(); const reopened = new Storage(f.root);
  try { const service = new AppService(reopened, new ProviderService(reopened, f.vault));
    const restored = get(service, a); assert.equal(restored.name, '新名字'); assert.equal(restored.favorite, true); assert.ok(restored.lastOpenedAt);
  } finally { reopened.close(); }
});

test('A02 incomplete/dependency states, missing credentials/provider/Skill and permission conflicts never publish', async t => {
  const f = fixture(t); let app = create(f.service);
  assert.equal(app.state, 'incomplete'); assert.ok(app.draftIssues.includes('MODEL_REQUIRED'));
  assert.equal(f.service.request({ operation: 'publish', ...ident(app) }).error.code, 'INVALID_INPUT');
  const setup = await configured(f); app = setup.app;
  for (const [draft, reason] of [
    [{ ...app.draft, model: { ...app.draft.model, providerProfileId: randomUUID() } }, 'PROVIDER_MISSING'],
    [{ ...app.draft, skills: [{ id: randomUUID(), version: '1.0.0', hash: 'a'.repeat(64) }] }, 'SKILL_UNRESOLVED'],
    [{ ...app.draft, permissions: { mode: 'chat', tools: ['read'] } }, 'PERMISSION_CONFLICT'],
    [{ ...app.draft, permissions: { mode: 'controlled-files', tools: ['shell'] } }, 'PERMISSION_CONFLICT'],
  ]) {
    app = edit(f.service, app, draft); assert.ok(app.draftIssues.includes(reason));
    assert.equal(f.service.request({ operation: 'publish', ...ident(app) }).error.code, 'INVALID_INPUT');
  }
  app = edit(f.service, app, setup.app.draft); app = publish(f.service, app); assert.equal(app.state, 'usable');
  f.vault.values.clear(); assert.equal(get(f.service, app).state, 'missing-dependencies');
  assert.ok(get(f.service, app).reasons.includes('CREDENTIAL_UNAVAILABLE')); assert.equal(app.trialStatus, 'not-tested');
});

test('A03 immutable snapshots freeze model behavior; credential rotation preserves history and endpoint changes fail closed', async t => {
  const f = fixture(t); let { app, p } = await configured(f); app = publish(f.service, app);
  const first = f.service.readRevision(app.id, app.currentRevisionId), folder = f.storage.paths.revision(app.id, first.id);
  const bytes = readFileSync(join(folder, 'manifest.json'));
  p = await provider(f.providers, p, cfg({ modelId: 'changed-model', settings: { timeoutMs: 5000 } }), 'rotated-test-key');
  const runtime = f.providers.snapshotRuntime(first.snapshot.credentialBinding, first.snapshot.provider);
  assert.equal(runtime.model.id, 'deepseek-flash'); assert.equal(runtime.timeoutMs, 3000); assert.equal(runtime.apiKey, 'rotated-test-key');
  assert.equal(get(f.service, app).state, 'usable'); assert.ok(get(f.service, app).draftIssues.includes('PROVIDER_CHANGED'));
  app = edit(f.service, app, { ...app.draft, role: '第二版角色', model: { ...app.draft.model, expectedRevision: p.revision } });
  app = publish(f.service, app); const second = f.service.readRevision(app.id, app.currentRevisionId);
  assert.equal(second.revision, 2); assert.notEqual(second.configHash, first.configHash);
  assert.deepEqual(f.service.readRevision(app.id, first.id), first); assert.deepEqual(readFileSync(join(folder, 'manifest.json')), bytes);
  assert.doesNotMatch(bytes.toString(), /rotated-test-key|controlled-test-key|secret:/);
  const raw = new DatabaseSync(f.storage.paths.database);
  try { assert.throws(() => raw.prepare('UPDATE revision_snapshots SET configHash=? WHERE revisionId=?').run('0'.repeat(64), first.id), /immutable/);
    assert.throws(() => raw.prepare('UPDATE app_revisions SET roleText=? WHERE id=?').run('tamper', first.id), /immutable/);
  } finally { raw.close(); }
  // Use a supported endpoint/provider change: DeepSeek /v1 aliases are rejected.
  await provider(f.providers, p, cfg({ providerType: 'openai', endpoint: 'https://api.openai.com/v1', modelId: 'controlled-model' }));
  assert.throws(() => f.providers.snapshotRuntime(first.snapshot.credentialBinding, first.snapshot.provider), { code: 'CREDENTIAL_UNAVAILABLE' });
  assert.equal(get(f.service, app).state, 'missing-dependencies');
});

test('A04 old conversations remain pinned while new conversations choose latest published revision', async t => {
  const f = fixture(t); let { app } = await configured(f); app = publish(f.service, app);
  const old = f.storage.createConversation(app.id, randomUUID(), '旧会话');
  app = edit(f.service, app, { ...app.draft, openingMessage: '新开场白' }); app = publish(f.service, app);
  const fresh = f.storage.createConversation(app.id, randomUUID(), '新会话');
  assert.equal(f.storage.conversations.get({ appId: app.id, id: old.id }).revisionId, old.revisionId);
  assert.equal(fresh.revisionId, app.currentRevisionId); assert.notEqual(fresh.revisionId, old.revisionId);
});

test('A05 stale draft and publish through independent SQLite connections cannot overwrite newer state', async t => {
  const f = fixture(t); const { app } = await configured(f);
  const other = new Storage(f.root);
  try {
    const service = new AppService(other, new ProviderService(other, f.vault));
    const newer = edit(service, app, { ...app.draft, role: '并发新角色' });
    for (const request of [{ operation: 'update', ...ident(app), draft: app.draft, metadata: metadata() }, { operation: 'publish', ...ident(app) }, { operation: 'copy', ...ident(app) }, { operation: 'archive', ...ident(app), archived: true }])
      assert.equal(f.service.request(request).error.code, 'VERSION_CONFLICT');
    assert.equal(get(f.service, app).draft.role, '并发新角色'); assert.equal(get(f.service, app).version, newer.version);
  } finally { other.close(); }
});

test('A06 real files, injected I/O failure, SQLite transaction abort and crash leftovers preserve previous current revision', async t => {
  let failure;
  const f = fixture(t, point => { if (point === failure) throw Object.assign(new Error('injected I/O error'), { code: 'EIO' }); });
  let { app } = await configured(f); app = publish(f.service, app);
  const first = f.service.readRevision(app.id, app.currentRevisionId), parent = dirname(f.storage.paths.revision(app.id, first.id));
  app = edit(f.service, app, { ...app.draft, role: 'changed' });
  for (failure of ['write', 'renamed', 'transaction']) {
    assert.equal(f.service.request({ operation: 'publish', ...ident(app) }).error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(get(f.service, app).currentRevisionId, first.id); assert.deepEqual(f.service.readRevision(app.id, first.id), first);
    assert.deepEqual(readdirSync(parent), [first.id]);
  }
  failure = undefined;
  const raw = new DatabaseSync(f.storage.paths.database);
  try {
    raw.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON revision_snapshots BEGIN SELECT RAISE(ABORT,'test disk database error'); END;");
    assert.equal(f.service.request({ operation: 'publish', ...ident(app) }).error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(get(f.service, app).currentRevisionId, first.id); assert.equal(f.storage.revisions.list({ appId: app.id }).length, 1);
    raw.exec('DROP TRIGGER fail_snapshot');
  } finally { raw.close(); }
  const stage = join(parent, `.staging-${randomUUID()}`), orphan = join(parent, randomUUID());
  for (const path of [stage, orphan]) { mkdirSync(path); writeFileSync(join(path, 'partial'), 'crash residue'); }
  new AppService(f.storage, f.providers); assert.equal(existsSync(stage), false); assert.equal(existsSync(orphan), false);
  assert.deepEqual(f.service.readRevision(app.id, first.id), first);
  app = publish(f.service, app); assert.notEqual(app.currentRevisionId, first.id);
  writeFileSync(join(f.storage.paths.revision(app.id, app.currentRevisionId), 'role.md'), 'tampered');
  assert.equal(get(f.service, app).state, 'missing-dependencies'); assert.throws(() => f.service.readRevision(app.id, app.currentRevisionId));
});

test('A07 copies strip all provider access, grants and history, including no-auth providers', async t => {
  const f = fixture(t); let { app } = await configured(f); app = publish(f.service, app);
  const conversation = f.storage.createConversation(app.id, randomUUID(), '原始会话');
  f.storage.grants.insert({ id: randomUUID(), appId: app.id, capability: 'files', resource: 'C:/private', mode: 'write', createdAt: Date.now() });
  f.storage.memories.insert({ id: randomUUID(), appId: app.id, version: 1, type: 'fact', content: 'private', status: 'active', confidence: null,
    sourceConversationId: conversation.id, sourceRunId: null, sourceMessageId: null, createdAt: Date.now(), updatedAt: Date.now(), expiresAt: null });
  const copy = ok(f.service.request({ operation: 'copy', ...ident(app) })).app;
  assert.notEqual(copy.id, app.id); assert.equal(copy.draft.role, app.draft.role); assert.equal(copy.draft.model, null);
  assert.equal(copy.currentRevisionId, null); assert.equal(copy.state, 'incomplete'); assert.equal(copy.lastOpenedAt, null);
  assert.equal(f.service.request({ operation: 'publish', ...ident(copy) }).error.code, 'INVALID_INPUT');
  for (const repo of [f.storage.grants, f.storage.conversations, f.storage.memories, f.storage.revisions]) assert.deepEqual(repo.list({ appId: copy.id }), []);
  assert.deepEqual(f.storage.artifacts.list({ appId: copy.id, conversationId: conversation.id }), []);
  assert.equal(f.storage.providers.list({}).length, 1); assert.equal(f.vault.values.size, 1);
  const noAuth = await f.providers.request({ operation: 'save', input: { config: cfg({ providerType: 'local-openai', endpoint: 'http://127.0.0.1:11434/v1', authMode: 'none' }), credential: { action: 'clear' } } });
  assert.equal(noAuth.ok, true);
  const p = noAuth.value.profile;
  const rebound = edit(f.service, copy, { ...copy.draft, model: { providerProfileId: p.id, expectedRevision: p.revision, temperature: 0.5, maxOutputTokens: 1024 } });
  const noAuthCopy = ok(f.service.request({ operation: 'copy', ...ident(rebound) })).app;
  assert.equal(noAuthCopy.draft.model, null); assert.equal(noAuthCopy.state, 'incomplete');
});

test('A08 archive hides entry, rejects active runs and new work, preserves history and restores', async t => {
  const f = fixture(t); let { app } = await configured(f); app = publish(f.service, app);
  const conversation = f.storage.createConversation(app.id, randomUUID(), '历史');
  const run = { id: randomUUID(), appId: app.id, conversationId: conversation.id, requestId: randomUUID(), state: 'queued', phase: 'created',
    version: 1, createdAt: Date.now(), startedAt: null, endedAt: null, error: null, usage: null };
  f.storage.createRun(run); assert.equal(ok(f.service.request({ operation: 'activeRuns', appId: app.id })).count, 1);
  assert.equal(f.service.request({ operation: 'archive', ...ident(app), archived: true }).error.code, 'APP_UNAVAILABLE');
  f.storage.transitionRun(app.id, run.id, 1, 'cancelled');
  app = ok(f.service.request({ operation: 'archive', ...ident(app), archived: true })).app;
  assert.equal(app.state, 'archived'); assert.equal(ok(f.service.request(list())).total, 0); assert.equal(ok(f.service.request(list({ archived: true }))).total, 1);
  assert.equal(f.service.request({ operation: 'open', appId: app.id }).error.code, 'APP_UNAVAILABLE');
  assert.throws(() => f.storage.createConversation(app.id, randomUUID(), 'forbidden'), { code: 'INVALID_TRANSITION' });
  assert.throws(() => f.storage.createRun({ ...run, id: randomUUID(), requestId: randomUUID() }), { code: 'INVALID_TRANSITION' });
  assert.equal(f.storage.conversations.list({ appId: app.id }).length, 1); assert.ok(f.service.readRevision(app.id, app.currentRevisionId));
  app = ok(f.service.request({ operation: 'archive', ...ident(app), archived: false })).app;
  assert.equal(app.state, 'usable'); assert.equal(ok(f.service.request(list())).total, 1);
});

test('A09 foreign revisions and arbitrary config/path/credential/validation fields are refused at service boundary', async t => {
  const f = fixture(t); let { app } = await configured(f); app = publish(f.service, app); const other = create(f.service, 'other');
  assert.equal(f.service.request({ operation: 'revision', appId: other.id, revisionId: app.currentRevisionId }).error.code, 'NOT_FOUND');
  for (const bad of [
    { ...app.draft, env: { KEY: 'injection' } }, { ...app.draft, args: ['--extension', 'evil'] },
    { ...app.draft, permissions: { ...app.draft.permissions, path: 'C:/private' } },
    { ...app.draft, model: { ...app.draft.model, secretRef: 'secret:fake' } },
    { ...app.draft, execution: { ...app.draft.execution, command: 'cmd.exe' } },
  ]) assert.equal(f.service.request({ operation: 'update', ...ident(app), metadata: metadata(), draft: bad }).error.code, 'INVALID_INPUT');
  for (const extra of [{ currentRevisionId: other.id }, { validation: { passed: true } }, { path: '../evil' }])
    assert.equal(f.service.request({ operation: 'publish', ...ident(app), ...extra }).error.code, 'INVALID_INPUT');
  assert.equal(f.service.request({ operation: 'create', metadata: metadata('bad', { icon: 'https://evil/image.svg' }) }).error.code, 'INVALID_INPUT');
  assert.equal(f.service.request({ operation: 'writeFile', path: 'anything' }).error.code, 'INVALID_INPUT');
});

test('A10 rename preserves app identity and published directory bytes', async t => {
  const f = fixture(t); let { app } = await configured(f); app = publish(f.service, app);
  const before = f.service.readRevision(app.id, app.currentRevisionId), directory = f.storage.paths.revision(app.id, app.currentRevisionId);
  const updated = edit(f.service, app, app.draft, metadata('全新名称'));
  assert.equal(updated.id, app.id); assert.equal(updated.currentRevisionId, app.currentRevisionId);
  assert.equal(f.storage.paths.revision(updated.id, updated.currentRevisionId), directory);
  assert.deepEqual(f.service.readRevision(updated.id, updated.currentRevisionId), before);
});

test('A01/A09 production Service Host allowlist roundtrip and restart, without Worker/model calls', async t => {
  const root = mkdtempSync(resolve('.test-apps-ipc-')); let manager;
  const start = async () => { manager = new ServiceManager({ nodePath: process.execPath, entry: resolve('dist/service-host.cjs'), dataRoot: root }); assert.equal((await manager.start()).ok, true); };
  t.after(async () => { await manager?.stop(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await start(); const app = ok(await manager.apps({ operation: 'create', metadata: metadata('IPC应用') })).app;
  assert.equal((await manager.apps({ operation: 'exec' })).error.code, 'INVALID_INPUT');
  assert.equal(ok(await manager.apps({ operation: 'get', appId: app.id })).app.name, app.name);
  await manager.stop(); await start(); assert.equal(ok(await manager.apps(list())).apps[0].id, app.id);
});
