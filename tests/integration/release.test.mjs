import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const bundle = mkdtempSync(resolve('.test-release-bundle-'));
await build({ entryPoints: ['tests/integration/fixtures/release-entry.ts'], outfile: join(bundle,'entry.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { Storage, ENGINE_VERSION, migrations, currentRelease, prepareRelease, recoverRelease, rollbackPlan, rollbackRelease, acquireDataLease, selectedDataRoot } = await import(pathToFileURL(join(bundle,'entry.mjs')));
after(() => rmSync(bundle, { recursive: true, force: true, maxRetries: 10 }));
function fixture(t) {
  const parent = mkdtempSync(resolve('.test-release-中文 空格-')), root = join(parent,'data root');
  t.after(() => rmSync(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const runtime = JSON.parse(readFileSync('dist/engine-runtime.json','utf8'));
  for (const key of ['node','cli','extension','nativeHost']) runtime[key] = resolve('dist',runtime[key]);
  const make = id => {
    const directory = join(parent,id); mkdirSync(directory);
    writeFileSync(join(directory,'engine-runtime.json'), JSON.stringify(runtime));
    writeFileSync(join(directory,'release-manifest.json'), JSON.stringify({id,schema:migrations.length,runtime:ENGINE_VERSION,channel:'internal-candidate',finalAcceptance:'PENDING'}));
    return currentRelease(directory);
  };
  return { parent, root, old: make('1111111111111111'), next: make('2222222222222222') };
}
test('release: migration changes only staging; schema failure and disk preflight retain old bytes',async t => {
  const f = fixture(t); await prepareRelease(f.root,f.old);
  writeFileSync(join(f.root,'sentinel'),'old');
  const before = readFileSync(join(f.root,'data/platform.db'));
  await assert.rejects(prepareRelease(f.root,f.next,{freeBytes:0}),/INSUFFICIENT_SPACE/);
  await assert.rejects(prepareRelease(f.root,f.next,{migrate: stage => {
    const db = new DatabaseSync(join(stage,'data/platform.db')); db.exec('CREATE TABLE half_migration(value TEXT)'); db.close(); throw Error('migration failed');
  }}),/migration failed/);
  assert.deepEqual(readFileSync(join(f.root,'data/platform.db')),before);
  assert.equal(readFileSync(join(f.root,'sentinel'),'utf8'),'old');
});
test('release: Pi incompatibility and missing old runtime fail before promotion',async t => {
  const f=fixture(t); await prepareRelease(f.root,f.old);
  await assert.rejects(prepareRelease(f.root,{...f.next,runtime:{...ENGINE_VERSION,pi:'unsupported'}}),/PI_INCOMPATIBLE/);
  rmSync(join(f.old.directory,'release-manifest.json'));
  await assert.rejects(prepareRelease(f.root,f.next));
  assert.equal(JSON.parse(readFileSync(join(f.root,'.release-state.json'))).active.id,f.old.id);
});
for (const point of ['copied','migrated','journal','archived','activated']) test(`release: interrupted ${point} selects one complete root`,async t => {
  const f=fixture(t); await prepareRelease(f.root,f.old); writeFileSync(join(f.root,'session.jsonl'),'original raw session\n');
  await assert.rejects(prepareRelease(f.root,f.next,{fault: at => { if(at===point) throw Error('power-loss fixture'); }}),/power-loss/);
  recoverRelease(f.root);
  const value=JSON.parse(readFileSync(join(f.root,'.release-state.json')));
  assert.equal(value.active.id,['copied','migrated'].includes(point)?f.old.id:f.next.id);
  assert.equal(readFileSync(join(f.root,'session.jsonl'),'utf8'),'original raw session\n');
  const storage=new Storage(f.root);storage.close();
});
test('release: rollback pairs old runtime and old schema; newer data remains archived',async t => {
  const f=fixture(t);await prepareRelease(f.root,f.old);writeFileSync(join(f.root,'memory'),'before');
  await prepareRelease(f.root,f.next);writeFileSync(join(f.root,'memory'),'after');
  const plan=rollbackPlan(f.root);assert.equal(plan.release.id,f.old.id);assert.match(plan.notice,/升级后/);
  assert.equal(await rollbackRelease(f.root),f.old.directory);
  assert.equal(readFileSync(join(f.root,'memory'),'utf8'),'before');
  const journal=JSON.parse(readFileSync(f.root+'.upgrade.json'));assert.equal(readFileSync(join(journal.archived,'memory'),'utf8'),'after');
  assert.ok(existsSync(join(plan.snapshot,'data/platform.db')));
  assert.equal(JSON.parse(readFileSync(join(f.root,'.release-state.json'))).active.id,f.old.id);
});
test('release: OS lease denies another host, survives held file and releases after close',async t => {
  const f=fixture(t), helper=resolve('dist/data-lease.exe');
  const release=await acquireDataLease(f.root,helper);
  await assert.rejects(acquireDataLease(f.root,helper),/DATA_ROOT_BUSY/);
  release();
  await new Promise(r=>setTimeout(r,100));
  const second=await acquireDataLease(f.root,helper);second();
  await new Promise(r=>setTimeout(r,100));
});

test('release: file occupation leaves original root intact and permits explicit retry', async t => {
  const f = fixture(t); await prepareRelease(f.root, f.old);
  const sentinel = join(f.root, 'held-file'); writeFileSync(sentinel, 'original');
  const holder = spawn(resolve('dist/data-lease.exe'), [sentinel], { windowsHide: true });
  const closed = once(holder, 'close'); t.after(() => holder.kill());
  await once(holder.stdout, 'data');
  await assert.rejects(prepareRelease(f.root, f.next));
  assert.equal(JSON.parse(readFileSync(join(f.root, '.release-state.json'))).active.id, f.old.id);
  holder.stdin.end(); await closed;
  await prepareRelease(f.root, f.next);
  assert.equal(readFileSync(join(f.root, 'held-file'), 'utf8'), 'original');
});

test('release: mismatched schema, corrupt rollback snapshot and stale confirmation fail closed', async t => {
  const f = fixture(t); await prepareRelease(f.root, f.old);
  await assert.rejects(prepareRelease(f.root, { ...f.next, schema: f.old.schema - 1 }), /ROLLBACK_REQUIRED/);
  await assert.rejects(prepareRelease(f.root, { ...f.next, schema: f.old.schema + 1 }), /MIGRATION_INVALID/);
  await prepareRelease(f.root, f.next);
  await assert.rejects(rollbackRelease(f.root, 'unconfirmed-snapshot'), /ROLLBACK_PLAN_CHANGED/);
  const plan = rollbackPlan(f.root);
  const db = new DatabaseSync(join(plan.snapshot, 'data/platform.db'));
  db.exec('DELETE FROM schema_migrations'); db.close();
  await assert.rejects(rollbackRelease(f.root), /SNAPSHOT_INVALID/);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.release-state.json'))).active.id, f.next.id);
});

test('release: restored data pointer selects interrupted upgrade for recovery, never unrelated fallback', async t => {
  const f = fixture(t); await prepareRelease(f.root, f.old);
  const profile = join(f.parent, 'profile'); mkdirSync(profile);
  writeFileSync(join(profile, 'data-root.json'), JSON.stringify({version: 1, active: f.root, previous: join(f.parent, 'previous')}));
  await assert.rejects(prepareRelease(f.root, f.next, { fault: point => { if (point === 'archived') throw Error('interrupted'); } }), /interrupted/);
  assert.equal(existsSync(f.root), false);
  assert.equal(selectedDataRoot(profile, 'unused'), f.root);
  recoverRelease(f.root);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.release-state.json'))).active.id, f.next.id);
});
