import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync, copyFileSync, mkdirSync, renameSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { Storage, DataPaths } from '@aiappnest/storage';
import { migrations } from '../../../packages/storage/src/migrations';
import { ENGINE_VERSION } from '../../../packages/pi-adapter/src/types';
import { readEngineRuntime, verifyRuntime } from '../../../packages/pi-adapter/src/config';
import { durableJson } from './backups';

export interface Release { id: string; directory: string; schema: number; runtime: typeof ENGINE_VERSION }
interface State { version: 1; active: Release; previous?: { release: Release; snapshot: string; createdAt: number } }
interface Journal { version: 1; root: string; stage: string; archived: string; state: State }
const marker = '.release-state.json';
const fail = (message: string): never => { throw new Error(message); };
function json(file: string) { return JSON.parse(readFileSync(file, 'utf8')); }
function safe(path: string) { new DataPaths(dirname(path)).assertManaged(path); }
function release(value: Release): Release {
  if (!value || !/^[a-f0-9]{16}$/.test(value.id) || !Number.isInteger(value.schema) || value.schema < 1
    || !value.directory || resolve(value.directory) !== value.directory) fail('INVALID_RELEASE');
  safe(value.directory);
  return value;
}
export function currentRelease(directory: string): Release | undefined {
  const file = join(directory, 'release-manifest.json');
  if (!existsSync(file)) return;
  const manifest = json(file);
  if (manifest.channel !== 'internal-candidate' || manifest.finalAcceptance !== 'PENDING') fail('INVALID_RELEASE_CHANNEL');
  const value = release({ id: manifest.id, directory: resolve(directory), schema: manifest.schema, runtime: manifest.runtime });
  if (value.schema !== migrations.length || JSON.stringify(value.runtime) !== JSON.stringify(ENGINE_VERSION)) fail('INCOMPATIBLE_RELEASE');
  verifyRuntime(readEngineRuntime(directory));
  return value;
}
function state(root: string): State | undefined {
  const file = join(root, marker); safe(file);
  if (!existsSync(file)) return;
  const value = json(file) as State;
  if (value.version !== 1) fail('INVALID_RELEASE_STATE');
  release(value.active);
  if (value.previous) { release(value.previous.release); safe(value.previous.snapshot); }
  return value;
}
function inventory(root: string): { path: string; bytes: number }[] {
  const paths = new DataPaths(root), files: { path: string; bytes: number }[] = [];
  const walk = (path: string) => {
    paths.assertManaged(path);
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    else {
      if (!stat.isFile() || stat.nlink !== 1) fail('LINKED_DATA');
      files.push({ path, bytes: stat.size });
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}
async function clone(root: string, stage: string, freeBytes?: number) {
  const files = inventory(root), bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const disk = statfsSync(dirname(root));
  if ((freeBytes ?? disk.bavail * disk.bsize) < bytes * 2 + 256 * 1024 ** 2) fail('INSUFFICIENT_SPACE');
  mkdirSync(stage); // Never overwrite a prior snapshot or interrupted staging tree.
  for (const file of files) {
    const name = file.path.slice(root.length + 1);
    if (/^data[\\/]platform\.db(?:-wal|-shm)?$/.test(name)) continue;
    const target = join(stage, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(file.path, target);
    if (createHash('sha256').update(readFileSync(target)).digest('hex') !== createHash('sha256').update(readFileSync(file.path)).digest('hex')) fail('COPY_MISMATCH');
  }
  const database = join(root, 'data/platform.db');
  if (existsSync(database)) {
    mkdirSync(join(stage, 'data'), { recursive: true });
    const db = new DatabaseSync(database, { readOnly: true });
    try { await backup(db, join(stage, 'data/platform.db')); } finally { db.close(); }
  }
}
/** Finish one interrupted directory exchange; never merge files or select a half-migrated DB. */
export function recoverRelease(root: string, fault: (point: string) => void = () => {}) {
  const file = root + '.upgrade.json'; safe(file);
  if (!existsSync(file)) return;
  const j = json(file) as Journal;
  if (j.version !== 1 || j.root !== root || !j.stage.startsWith(root + '.stage-') || !j.archived.startsWith(root + '.snapshot-')
    || dirname(j.stage) !== dirname(root) || dirname(j.archived) !== dirname(root)) fail('INVALID_UPGRADE_JOURNAL');
  for (const path of [root, j.stage, j.archived]) safe(path);
  if (existsSync(j.stage)) {
    if (existsSync(root)) {
      if (existsSync(j.archived)) fail('AMBIGUOUS_UPGRADE');
      renameSync(root, j.archived); fault('archived');
    }
    renameSync(j.stage, root); fault('activated');
  }
  if (!existsSync(root) || JSON.stringify(state(root)) !== JSON.stringify(j.state)) fail('INCOMPLETE_UPGRADE');
  // Preserve the completed journal as evidence. The next transaction replaces it atomically.
}
function checkOldRuntime(old: Release) {
  release(old);
  const packaged = json(join(old.directory, 'release-manifest.json'));
  if (packaged.id !== old.id || packaged.schema !== old.schema || JSON.stringify(packaged.runtime) !== JSON.stringify(old.runtime)) fail('OLD_RUNTIME_UNAVAILABLE');
  const runtime = readEngineRuntime(old.directory);
  for (const key of ['node', 'cli', 'extension', 'nativeHost'] as const) {
    if (createHash('sha256').update(readFileSync(runtime[key])).digest('hex') !== runtime.hashes[key]) fail('OLD_RUNTIME_UNAVAILABLE');
  }
}
export async function prepareRelease(root: string, next: Release, options: { fault?: (point: string) => void; freeBytes?: number; migrate?: (root: string) => void } = {}) {
  root = resolve(root); safe(root); release(next); recoverRelease(root);
  const old = state(root);
  if (old?.active.id === next.id) return;
  if (old) {
    checkOldRuntime(old.active);
    if (next.schema < old.active.schema) fail('ROLLBACK_REQUIRED');
    // A session protocol change needs a separately implemented importer, never JSONL editing.
    if (JSON.stringify(old.active.runtime) !== JSON.stringify(next.runtime)) fail('PI_INCOMPATIBLE');
  } else if (existsSync(join(root, 'data/platform.db'))) {
    // Adoption of a restored root is allowed only for the exact existing schema, without migration.
    const db = new DatabaseSync(join(root, 'data/platform.db'), { readOnly: true });
    try { if (db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n !== next.schema) fail('UNMANAGED_SCHEMA'); } finally { db.close(); }
  }
  mkdirSync(dirname(root), { recursive: true });
  const suffix = randomUUID(), stage = root + '.stage-' + suffix, archived = root + '.snapshot-' + suffix;
  const fault = options.fault ?? (() => {});
  await clone(root, stage, options.freeBytes); fault('copied');
  (options.migrate ?? (path => { const storage = new Storage(path); storage.close(); }))(stage);
  fault('migrated');
  const db = new DatabaseSync(join(stage, 'data/platform.db'), { readOnly: true });
  try { if (db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n !== next.schema
    || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('MIGRATION_INVALID'); } finally { db.close(); }
  // An exact-schema imported root has no older installed binary: the current runtime is its baseline.
  const newState: State = { version: 1, active: next, ...(existsSync(root) ? { previous: { release: old?.active ?? next, snapshot: archived, createdAt: Date.now() } } : {}) };
  durableJson(join(stage, marker), newState);
  const journal: Journal = { version: 1, root, stage, archived, state: newState };
  durableJson(root + '.upgrade.json', journal); fault('journal'); recoverRelease(root, fault);
}
export function rollbackPlan(root: string) {
  safe(root); recoverRelease(root);
  const value = state(root);
  if (!value?.previous) fail('NO_ROLLBACK_SNAPSHOT');
  const previous = value!.previous!; checkOldRuntime(previous.release);
  safe(previous.snapshot);
  if (!existsSync(join(previous.snapshot, 'data/platform.db'))) fail('SNAPSHOT_UNAVAILABLE');
  return { ...previous, affectedRoot: root, notice: '回退会恢复升级前的全部数据。升级后新增的会话、产物、记忆、设置和凭据将退出当前视图，保留在旁边的 snapshot 目录。不会重放任务。' };
}
export async function rollbackRelease(root: string, expectedSnapshot?: string) {
  const plan = rollbackPlan(root), suffix = randomUUID();
  if (expectedSnapshot !== undefined && plan.snapshot !== expectedSnapshot) fail('ROLLBACK_PLAN_CHANGED');
  const stage = root + '.stage-' + suffix, archived = root + '.snapshot-' + suffix;
  await clone(plan.snapshot, stage);
  const db = new DatabaseSync(join(stage, 'data/platform.db'), { readOnly: true });
  try { if (db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n !== plan.release.schema
    || db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('SNAPSHOT_INVALID'); } finally { db.close(); }
  const restored: State = { version: 1, active: plan.release };
  durableJson(join(stage, marker), restored);
  durableJson(root + '.upgrade.json', { version: 1, root, stage, archived, state: restored });
  recoverRelease(root);
  return plan.release.directory;
}
