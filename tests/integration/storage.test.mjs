import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { ServiceManager } from '../../dist/service-manager.cjs';

const bundleRoot = mkdtempSync(resolve('.test-storage-bundle-'));
after(() => rmSync(bundleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
await build({ entryPoints: ['tests/integration/fixtures/storage-entry.ts'], outfile: join(bundleRoot,'storage.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24' });
const { Storage, DataPaths, resolveDataRoot, migrations, migrate, id, timestamp, runTransitions } = createRequire(import.meta.url)(join(bundleRoot,'storage.cjs'));
const now = 1791000000000;
const uuid = () => randomUUID();
const fails = (action, code) => assert.throws(action, error => error.code === code);
function fixture(t) {
  const root = mkdtempSync(resolve('.test-storage-中文 空格-'));
  const storage = new Storage(root);
  const raw = new DatabaseSync(storage.paths.database); raw.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=50');
  t.after(() => { raw.close(); storage.close(); rmSync(root,{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, storage, raw };
}
function seed(storage) {
  const provider = storage.providers.insert({ id: uuid(), name: 'fixture', providerType: 'fixture', modelId: 'fixture', authMode: 'api-key', revision: 1, endpoint: 'https://example.invalid/v1', secretRef: `secret:${uuid()}`, settings: { timeoutMs: 3000 }, createdAt: now, updatedAt: now });
  const app = storage.apps.insert({ id: uuid(), name: "中文应用 '; DROP TABLE apps;--", description: '', icon: null, status: 'draft', currentRevisionId: null, version: 1, createdAt: now, updatedAt: now });
  const skillId = uuid();
  const skill = storage.skills.insert({ id: skillId, version: '1.0.0', hash: 'a'.repeat(64), sourcePath: `skills/${skillId}/1.0.0`, metadata: { name: 'same-name', description: '' }, importedAt: now });
  const revision = { id: uuid(), appId: app.id, revision: 1, providerProfileId: provider.id, config: { schemaVersion: 1, modelId: 'fixture', memory: { enabled: true, maxItems: 8, tokenBudget: 1500 }, permissions: { mode: 'chat', shell: false } }, roleText: '角色', runtimeVersion: '0.73.1', createdAt: now };
  storage.publishRevision(revision, [{ revisionId: revision.id, skillId: skill.id, skillVersion: skill.version, enabled: true }], 1);
  const conversation = storage.conversations.insert({ id: uuid(), appId: app.id, revisionId: revision.id, title: '会话', piSessionFile: null, status: 'active', createdAt: now, updatedAt: now });
  const run = storage.createRun({ id: uuid(), appId: app.id, conversationId: conversation.id, requestId: uuid(), state: 'queued', phase: 'created', version: 1, createdAt: now, startedAt: null, endedAt: null, error: null, usage: null });
  const message = storage.messages.insert({ id: uuid(), appId: app.id, conversationId: conversation.id, runId: run.id, role: 'user', content: "用户输入 ? ';--", status: 'complete', createdAt: now });
  const memory = storage.memories.insert({ id: uuid(), appId: app.id, version: 1, type: 'fact', content: '记忆', status: 'active', confidence: 0.9, sourceConversationId: conversation.id, sourceRunId: run.id, sourceMessageId: message.id, createdAt: now, updatedAt: now, expiresAt: null });
  return { app, provider, revision, skill, conversation, run, message, memory };
}

test('S01 fresh initialization, verified connection settings, core round trips and restart persistence', t => {
  const { storage, root, raw } = fixture(t); const a = seed(storage);
  assert.deepEqual(storage.settings(), { foreignKeys: 1, journalMode: 'wal', busyTimeout: 3000, synchronous: 2 });
  assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,migrations.length);
  assert.equal(storage.apps.get({ id: a.app.id }).name,a.app.name);
  assert.deepEqual(storage.revisions.get({ id: a.revision.id, appId: a.app.id }),a.revision);
  assert.deepEqual(storage.providers.get({ id: a.provider.id }),a.provider);
  assert.deepEqual(storage.skills.get({ id: a.skill.id, version: a.skill.version }),a.skill);
  assert.equal(storage.appSkills.list({ revisionId: a.revision.id })[0].enabled,true);
  const grant = storage.grants.insert({ id: uuid(), appId: a.app.id, capability: 'files', resource: 'workspace', mode: 'read', createdAt: now });
  assert.deepEqual(storage.grants.get({ id: grant.id, appId: a.app.id }),grant);
  const event = storage.appendEvent(a.app.id,a.run.id,'submitted',{ text: '中文' },now);
  assert.deepEqual(storage.events.get({ runId: a.run.id, seq: 1 }),event);
  storage.close(); storage.close();
  const reopened = new Storage(root);
  try { assert.deepEqual(reopened.messages.get({ id: a.message.id, appId: a.app.id }),a.message); assert.deepEqual(reopened.memories.get({ id: a.memory.id, appId: a.app.id, version: 1 }),a.memory); }
  finally { reopened.close(); }
});

test('S02 migration upgrade is transactional, ordered, recorded and idempotent', t => {
  const { storage, raw } = fixture(t); seed(storage);
  const steps = [...migrations,{ version: migrations.length + 1, name: 'test-upgrade', sql: 'CREATE TABLE upgrade_marker (id INTEGER PRIMARY KEY) STRICT;' }];
  migrate(raw,steps); migrate(raw,steps);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,migrations.length + 1);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM apps').get().n,1);
  assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('S03 migration failure/history drift/future schema/corrupt files fail without destructive rebuild', t => {
  const { storage, root, raw } = fixture(t); const a = seed(storage);
  assert.throws(() => migrate(raw,[...migrations,{ version: migrations.length + 1, name: 'broken', sql: 'CREATE TABLE partial (id INTEGER); INSERT INTO missing VALUES(1);' }]));
  assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(),undefined);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,migrations.length);
  fails(() => migrate(raw,[{ ...migrations[0], sql: `${migrations[0].sql} -- changed` }]),'STORAGE_UNAVAILABLE');
  raw.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(migrations.length + 1,'future','checksum',now);
  fails(() => new Storage(root),'STORAGE_UNAVAILABLE');
  assert.equal(storage.apps.get({ id: a.app.id }).name,a.app.name);
  const brokenRoot = join(root,'broken'); mkdirSync(join(brokenRoot,'data'),{ recursive: true });
  const path = join(brokenRoot,'data','platform.db'); const bytes = Buffer.from('not a SQLite database'); writeFileSync(path,bytes);
  fails(() => new Storage(brokenRoot),'STORAGE_UNAVAILABLE'); assert.deepEqual(readFileSync(path),bytes);
});

test('S04 app/revision/conversation/run ownership enforced by repositories and composite foreign keys', t => {
  const { storage, raw } = fixture(t); const a = seed(storage), b = seed(storage);
  assert.throws(() => raw.prepare('UPDATE apps SET currentRevisionId=? WHERE id=?').run(b.revision.id,a.app.id),/FOREIGN KEY/);
  fails(() => storage.conversations.insert({ ...a.conversation, id: uuid(), revisionId: b.revision.id }),'OWNERSHIP_MISMATCH');
  fails(() => storage.runs.insert({ ...a.run, id: uuid(), requestId: uuid(), conversationId: b.conversation.id }),'OWNERSHIP_MISMATCH');
  fails(() => storage.runs.insert({ ...a.run, id: uuid(), requestId: uuid(), conversationId: uuid() }),'OWNERSHIP_MISMATCH');
  fails(() => storage.conversations.get({ appId: b.app.id, id: a.conversation.id }),'NOT_FOUND');
  assert.deepEqual(storage.conversations.list({ appId: b.app.id }),[b.conversation]);
});

test('S05 published revisions and skill bindings immutable; new publication preserves old conversations', t => {
  const { storage, raw } = fixture(t); const a = seed(storage);
  for (const sql of ['UPDATE app_revisions SET roleText=roleText', 'DELETE FROM app_revisions', 'UPDATE app_skills SET enabled=0', 'DELETE FROM app_skills', 'UPDATE skills SET hash=hash']) assert.throws(() => raw.exec(sql),/immutable/);
  fails(() => storage.appSkills.insert({ revisionId: a.revision.id, skillId: uuid(), skillVersion: '1.0.0', enabled: true }),'VERSION_CONFLICT');
  const next = { ...a.revision, id: uuid(), revision: 2 };
  fails(() => storage.publishRevision(next,[],1),'VERSION_CONFLICT');
  storage.publishRevision(next,[],2);
  assert.equal(storage.apps.get({ id: a.app.id }).currentRevisionId,next.id);
  assert.equal(storage.conversations.get({ id: a.conversation.id, appId: a.app.id }).revisionId,a.revision.id);
  assert.throws(() => raw.prepare('UPDATE conversations SET revisionId=? WHERE id=?').run(next.id,a.conversation.id),/immutable/);
  const bad = { ...a.revision, id: uuid(), revision: 3 };
  fails(() => storage.publishRevision(bad,[{ revisionId: bad.id, skillId: uuid(), skillVersion: '1.0.0', enabled: true }],3),'OWNERSHIP_MISMATCH');
  fails(() => storage.revisions.get({ id: bad.id, appId: a.app.id }),'NOT_FOUND');
});

test('S06 nullable message run and session lifecycle; mismatched conversation rejected', t => {
  const { storage, root } = fixture(t); const a = seed(storage);
  const other = storage.conversations.insert({ ...a.conversation, id: uuid() });
  fails(() => storage.messages.insert({ ...a.message, id: uuid(), conversationId: other.id }),'OWNERSHIP_MISMATCH');
  assert.equal(storage.messages.insert({ ...a.message, id: uuid(), runId: null }).runId,null);
  const streaming = storage.messages.insert({ ...a.message, id: uuid(), status: 'streaming' });
  storage.updateMessage(a.app.id,streaming.id,'partial','streaming');
  assert.equal(storage.updateMessage(a.app.id,streaming.id,'final','complete').content,'final');
  fails(() => storage.updateMessage(a.app.id,streaming.id,'rewrite','streaming'),'INVALID_TRANSITION');
  assert.equal(a.conversation.piSessionFile,null);
  const file = join(storage.paths.conversation(a.app.id,a.conversation.id,'sessions'),'engine-generated.jsonl');
  assert.equal(storage.attachSessionFile(a.app.id,a.conversation.id,file).piSessionFile,file);
  assert.equal(storage.attachSessionFile(a.app.id,a.conversation.id,file).piSessionFile,file);
  fails(() => storage.attachSessionFile(a.app.id,a.conversation.id,join(root,'escape.jsonl')),'INVALID_INPUT');
  fails(() => storage.attachSessionFile(a.app.id,a.conversation.id,file.replace('engine-generated','different')),'VERSION_CONFLICT');
});

test('S07 artifacts require consistent app/conversation/run and generated ID paths', t => {
  const { storage } = fixture(t); const a = seed(storage), b = seed(storage); const artifactId = uuid();
  const artifact = { id: artifactId, appId: a.app.id, conversationId: a.conversation.id, runId: a.run.id, relativePath: storage.paths.artifact(a.app.id,a.conversation.id,artifactId), mimeType: 'text/plain', size: 20, hash: 'b'.repeat(64), createdAt: now };
  assert.deepEqual(storage.artifacts.insert(artifact),{ ...artifact,displayName:'',sourceKey:'' });
  assert.deepEqual(storage.artifacts.list({ appId: a.app.id, conversationId: a.conversation.id }),[{ ...artifact,displayName:'',sourceKey:'' }]);
  const forgedId = uuid();
  fails(() => storage.artifacts.insert({ ...artifact, id: forgedId, relativePath: storage.paths.artifact(a.app.id,a.conversation.id,forgedId), runId: b.run.id }),'OWNERSHIP_MISMATCH');
  fails(() => storage.artifacts.insert({ ...artifact, relativePath: '../outside' }),'INVALID_INPUT');
  fails(() => storage.artifacts.insert({ ...artifact, size: -1 }),'INVALID_INPUT');
});

test('S08 all non-null memory sources must exist and agree on ownership', t => {
  const { storage } = fixture(t); const a = seed(storage), b = seed(storage);
  for (const source of ['sourceConversationId','sourceRunId','sourceMessageId']) {
    fails(() => storage.memories.insert({ ...a.memory, id: uuid(), [source]: b.memory[source] }),'OWNERSHIP_MISMATCH');
    fails(() => storage.memories.insert({ ...a.memory, id: uuid(), [source]: uuid() }),'OWNERSHIP_MISMATCH');
  }
  const other = storage.createRun({ ...a.run, id: uuid(), requestId: uuid() });
  fails(() => storage.memories.insert({ ...a.memory, id: uuid(), sourceRunId: other.id }),'OWNERSHIP_MISMATCH');
  assert.equal(storage.memories.insert({ ...a.memory, id: uuid(), sourceConversationId: null, sourceRunId: null, sourceMessageId: null }).sourceMessageId,null);
});

test('S09 memory versions and injection history retained; deletion/expiry/app filtering apply to future retrieval', t => {
  const { storage, raw } = fixture(t); const a = seed(storage), b = seed(storage);
  const link = { runId: a.run.id, appId: a.app.id, memoryId: a.memory.id, memoryVersion: 1, position:0, injectedTextHash: 'c'.repeat(64) };
  storage.memoryLinks.insert(link);
  fails(() => storage.memoryLinks.insert({ ...link, memoryId: b.memory.id }),'OWNERSHIP_MISMATCH');
  fails(() => storage.memoryLinks.insert({ ...link, memoryVersion: 2 }),'OWNERSHIP_MISMATCH');
  storage.reviseMemory({ ...a.memory, version: 2, status: 'deleted', updatedAt: now+1 },1);
  assert.deepEqual(storage.activeMemories(a.app.id,now+2),[]);
  assert.deepEqual(storage.activeMemories(b.app.id,now+2),[b.memory]);
  assert.deepEqual(storage.memoryLinks.list({ runId: a.run.id }),[link]);
  assert.deepEqual(storage.memories.get({ id: a.memory.id, appId: a.app.id, version: 1 }),a.memory);
  fails(() => storage.reviseMemory({ ...a.memory, version: 2 },1),'VERSION_CONFLICT');
  assert.throws(() => raw.exec('UPDATE memories SET content=content'),/immutable/);
  assert.throws(() => raw.exec('DELETE FROM memories'),/immutable/);
  storage.memories.insert({ ...a.memory, id: uuid(), expiresAt: now });
  assert.deepEqual(storage.activeMemories(a.app.id,now),[]);
  fails(() => storage.memories.insert({ ...a.memory, version: 3, appId: b.app.id, sourceConversationId: null, sourceRunId: null, sourceMessageId: null }),'OWNERSHIP_MISMATCH');
});

test('S10 request deduplication is conversation-scoped and database-enforced', t => {
  const { storage } = fixture(t); const a = seed(storage), b = seed(storage);
  assert.deepEqual(storage.createRun({ ...a.run, id: uuid() }),a.run);
  fails(() => storage.runs.insert({ ...a.run, id: uuid() }),'DUPLICATE_RECORD');
  const other = storage.createRun({ ...b.run, id: uuid(), requestId: a.run.requestId });
  assert.notEqual(other.id,a.run.id);
  assert.equal(storage.runs.list({ appId: a.app.id, conversationId: a.conversation.id }).length,1);
});

test('S11 event sequence monotonicity, duplicate prevention, ordering and pagination', t => {
  const { storage } = fixture(t); const a = seed(storage);
  const first = storage.appendEvent(a.app.id,a.run.id,'one',{},now);
  fails(() => storage.events.insert(first),'VERSION_CONFLICT');
  fails(() => storage.events.insert({ ...first, seq: 3 }),'VERSION_CONFLICT');
  storage.appendEvent(a.app.id,a.run.id,'two',null,now);
  assert.equal(storage.events.get({ runId: a.run.id, seq: 2 }).payload,null);
  assert.deepEqual(storage.events.list({ runId: a.run.id }).map(e => e.seq),[1,2]);
  assert.equal(storage.events.list({ runId: a.run.id },{ limit: 1, offset: 1 })[0].seq,2);
  fails(() => storage.events.list({ runId: a.run.id },{ limit: 1001 }),'INVALID_INPUT');
});

test('S12 legal run transitions/phases, optimistic concurrency and one active run per conversation', t => {
  const { storage, raw } = fixture(t); const a = seed(storage);
  fails(() => storage.transitionRun(a.app.id,a.run.id,1,'succeeded',now),'INVALID_TRANSITION');
  const starting = storage.transitionRun(a.app.id,a.run.id,1,'starting',now+1); assert.equal(starting.phase,'started');
  fails(() => storage.transitionRun(a.app.id,a.run.id,1,'running',now+2),'VERSION_CONFLICT');
  const queued = storage.createRun({ ...a.run, id: uuid(), requestId: uuid() });
  fails(() => storage.transitionRun(a.app.id,queued.id,1,'starting',now+2),'DUPLICATE_RECORD');
  assert.equal(storage.transitionRun(a.app.id,a.run.id,2,'running',now+2).phase,'accepted');
  storage.transitionRun(a.app.id,a.run.id,3,'waiting_approval',now+3);
  storage.transitionRun(a.app.id,a.run.id,4,'cancelling',now+4);
  assert.equal(storage.transitionRun(a.app.id,a.run.id,5,'cancelled',now+5).phase,'completed');
  fails(() => storage.transitionRun(a.app.id,a.run.id,6,'running',now+6),'INVALID_TRANSITION');
  assert.throws(() => raw.prepare("UPDATE runs SET state='running',phase='accepted',version=version+1 WHERE id=?").run(queued.id),/invalid transition/);
  const cancelled = storage.transitionRun(a.app.id,queued.id,1,'cancelled',now+6); assert.equal(cancelled.startedAt,null);
  // Exercise every documented edge against the actual triggers using a fresh run.
  const paths = { queued: [], starting: ['starting'], running: ['starting','running'], waiting_approval: ['starting','running','waiting_approval'], cancelling: ['starting','running','cancelling'] };
  for (const [from,targets] of Object.entries(runTransitions)) for (const target of targets) {
    const run = storage.createRun({ ...a.run, id: uuid(), requestId: uuid() }); let current = run;
    for (const state of [...paths[from],target]) current = storage.transitionRun(a.app.id,run.id,current.version,state,now+10);
    if (runTransitions[target].length) {
      const ending = target === 'queued' ? 'cancelled' : target === 'cancelling' ? 'cancelled' : 'interrupted';
      storage.transitionRun(a.app.id,run.id,current.version,ending,now+11);
    }
  }
});

test('S13 nested transactions, atomic completion and rollback, synchronous-only callbacks', t => {
  const { storage } = fixture(t); const a = seed(storage), b = seed(storage);
  storage.transitionRun(a.app.id,a.run.id,1,'starting',now); storage.transitionRun(a.app.id,a.run.id,2,'running',now);
  const final = { ...a.message, id: uuid(), role: 'assistant', content: '完成', createdAt: now+1 };
  fails(() => storage.finishRun(a.app.id,a.run.id,3,'succeeded',{ ...final, conversationId: b.conversation.id },now+1),'OWNERSHIP_MISMATCH');
  assert.equal(storage.runs.get({ id: a.run.id, appId: a.app.id }).state,'running');
  assert.equal(storage.events.list({ runId: a.run.id }).length,0);
  storage.finishRun(a.app.id,a.run.id,3,'succeeded',final,now+1);
  assert.equal(storage.messages.get({ id: final.id, appId: a.app.id }).content,'完成');
  assert.equal(storage.events.list({ runId: a.run.id })[0].type,'run.completed');
  storage.transitionRun(b.app.id,b.run.id,1,'starting',now); storage.transitionRun(b.app.id,b.run.id,2,'running',now);
  const streaming = storage.messages.insert({ ...b.message, id: uuid(), role: 'assistant', status: 'streaming' });
  storage.finishRun(b.app.id,b.run.id,3,'succeeded',{ ...streaming, content: 'final projection', status: 'complete' },now+1);
  assert.equal(storage.messages.get({ id: streaming.id, appId: b.app.id }).content,'final projection');
  const rolledBack = uuid();
  assert.throws(() => storage.transaction(() => { storage.messages.insert({ ...a.message, id: rolledBack }); storage.transaction(() => { throw new Error('rollback'); }); }));
  fails(() => storage.messages.get({ id: rolledBack, appId: a.app.id }),'NOT_FOUND');
  let called = false;
  fails(() => storage.transaction(async () => { called = true; }),'INVALID_INPUT'); assert.equal(called,false);
  storage.transaction(() => {
    assert.throws(() => storage.transaction(() => { storage.messages.insert({ ...a.message, id: rolledBack }); throw new Error('nested'); }));
    storage.messages.insert({ ...a.message, id: uuid() });
  });
  fails(() => storage.messages.get({ id: rolledBack, appId: a.app.id }),'NOT_FOUND');
});

test('S14 real WAL reader/writer isolation, busy timeout and rollback on lock contention', t => {
  const { storage, raw } = fixture(t); const a = seed(storage);
  raw.exec('BEGIN'); assert.equal(raw.prepare('SELECT version FROM apps WHERE id=?').get(a.app.id).version,2);
  storage.updateApp(a.app.id,2,{ name: 'updated', description: '', icon: null, status: 'ready' },now+1);
  assert.equal(raw.prepare('SELECT version FROM apps WHERE id=?').get(a.app.id).version,2); raw.exec('COMMIT');
  assert.equal(raw.prepare('SELECT version FROM apps WHERE id=?').get(a.app.id).version,3);
  raw.exec('BEGIN IMMEDIATE'); const started = performance.now();
  try { fails(() => storage.updateApp(a.app.id,3,{ name: 'blocked', description: '', icon: null, status: 'ready' },now+2),'STORAGE_UNAVAILABLE'); }
  finally { raw.exec('ROLLBACK'); }
  assert.ok(performance.now()-started >= 2500);
  assert.equal(storage.apps.get({ id: a.app.id }).name,'updated');
});

test('S15 Windows paths: Chinese/spaces, safe IDs, no traversal/UNC/device names or existing junction escape', t => {
  const { root, storage } = fixture(t); const a = seed(storage);
  assert.equal(resolveDataRoot(undefined,root),join(root,'LocalAIHub'));
  for (const path of ['relative','..','\\\\server\\share']) fails(() => resolveDataRoot(path),'INVALID_INPUT');
  for (const value of ['..','../x','a/b','a\\b','C:escape','CON','x.','x ','x:stream',"x';--"]) fails(() => storage.paths.revision(value,a.revision.id),'INVALID_INPUT');
  fails(() => storage.paths.skill(a.skill.id,'../x'),'INVALID_INPUT');
  const directory = storage.paths.conversation(a.app.id,a.conversation.id,'workspace'); storage.paths.ensureDirectory(directory); assert.ok(existsSync(directory));
  const outside = join(root,'outside'); mkdirSync(outside);
  const linked = join(root,'apps','linked'); symlinkSync(outside,linked,process.platform === 'win32' ? 'junction' : 'dir');
  fails(() => storage.paths.ensureDirectory(join(linked,'child')),'INVALID_INPUT'); assert.equal(existsSync(join(outside,'child')),false);
  fails(() => storage.paths.assertManaged(join(root,'..','sibling')),'INVALID_INPUT');
  assert.ok(relative(root,storage.paths.revision(a.app.id,a.revision.id)).startsWith(`apps${sep}`));
  assert.equal(id(a.app.id),a.app.id); assert.equal(timestamp(now),now);
  for (const value of [-1,1.5,NaN,Infinity]) fails(() => timestamp(value),'INVALID_INPUT');
});

test('S16 credential references only, strict JSON configuration and bound SQL values', t => {
  const { storage, raw } = fixture(t); const a = seed(storage);
  for (const bad of [{ apiKey: 'fake-key' },{ settings: { timeoutMs: 100, apiKey: 'fake-key' } },{ endpoint: 'https://user:password@example.invalid' },{ endpoint: 'https://example.invalid?api_key=fake' },{ secretRef: 'fake-key' }]) fails(() => storage.providers.insert({ ...a.provider, id: uuid(), ...bad }),'INVALID_INPUT');
  fails(() => storage.revisions.insert({ ...a.revision, id: uuid(), revision: 2, config: { ...a.revision.config, apiKey: 'fake-key' } }),'INVALID_INPUT');
  fails(() => storage.apps.get({ id: "' OR 1=1--" }),'INVALID_INPUT');
  assert.equal(raw.prepare('SELECT name FROM apps WHERE id=?').get(a.app.id).name,a.app.name);
  assert.ok(!raw.prepare('PRAGMA table_info(provider_profiles)').all().some(column => /api.?key|password/i.test(column.name)));
});

test('S17 actual Service Host initializes before ready, closes/restarts, preserves data and reports storage failure', async t => {
  const root = mkdtempSync(resolve('.test-storage-host-')); const managers = [];
  t.after(async () => { for (const manager of managers) await manager.stop(); rmSync(root,{ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const start = (dataRoot) => { const manager = new ServiceManager({ nodePath: process.execPath, entry: resolve('dist/service-host.cjs'), dataRoot, startupMs: 5000 }); managers.push(manager); return manager; };
  const first = start(root); assert.equal((await first.start()).ok,true); assert.ok(existsSync(join(root,'data','platform.db'))); await first.stop();
  const storage = new Storage(root); const a = seed(storage); storage.transitionRun(a.app.id,a.run.id,1,'starting',now); storage.close();
  const second = start(root); assert.equal((await second.start()).ok,true); await second.stop();
  const reopened = new Storage(root); assert.equal(reopened.apps.get({ id: a.app.id }).name,a.app.name);
  const recovered = reopened.runs.get({ id: a.run.id, appId: a.app.id });
  assert.equal(recovered.state,'interrupted'); assert.equal(recovered.error,'RECOVERY_REQUIRED'); reopened.close();
  const bad = join(root,'bad'); mkdirSync(join(bad,'data'),{ recursive: true }); const path = join(bad,'data','platform.db'); writeFileSync(path,'corrupt');
  const failed = start(bad); const result = await failed.start(); assert.equal(result.ok,false); assert.equal(result.error.code,'STORAGE_UNAVAILABLE');
  assert.doesNotMatch(result.error.message,/platform\.db|\\|corrupt/); assert.equal(readFileSync(path,'utf8'),'corrupt');
  const invalid = join(root,'file'); writeFileSync(invalid,'not a directory'); assert.equal((await start(invalid).start()).error.code,'STORAGE_UNAVAILABLE');
});

test('S18 product storage boundary and explicit retention: no implicit cascading deletes', t => {
  const { storage, raw } = fixture(t); const a = seed(storage);
  assert.throws(() => raw.prepare('DELETE FROM apps WHERE id=?').run(a.app.id),/FOREIGN KEY/);
  assert.throws(() => raw.prepare('DELETE FROM conversations WHERE id=?').run(a.conversation.id),/FOREIGN KEY/);
  assert.throws(() => raw.prepare('DELETE FROM runs WHERE id=?').run(a.run.id),/FOREIGN KEY/);
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    for (const fk of raw.prepare(`PRAGMA foreign_key_list(${name})`).all()) assert.notEqual(fk.on_delete,'CASCADE');
  }
  for (const file of ['main.cjs','preload.cjs','service-manager.cjs']) assert.doesNotMatch(readFileSync(resolve('dist',file),'utf8'),/node:sqlite|CREATE TABLE|platform\.db/);
  for (const file of readdirSync(resolve('dist/renderer/assets')).filter(file => file.endsWith('.js'))) assert.doesNotMatch(readFileSync(resolve('dist/renderer/assets',file),'utf8'),/node:sqlite|CREATE TABLE|platform\.db/);
  assert.match(readFileSync(resolve('dist/service-host.cjs'),'utf8'),/node:sqlite/);
  assert.equal(storage.messages.list({ appId: a.app.id, conversationId: a.conversation.id }).length,1);
});
