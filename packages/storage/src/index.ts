import { DatabaseSync } from 'node:sqlite';
import { join, isAbsolute, relative, sep } from 'node:path';
import {
  DomainError, assertMessageTransition, assertRunTransition, terminalRunStates, timestamp,
  type App, type AppId, type AppRevision, type AppSkill, type Artifact, type Conversation, type ConversationId,
  type Grant, type Memory, type Message, type ProviderProfile, type Run, type RunId, type RunState,
  type RunEvent, type RunMemoryLink, type Skill, type Timestamp,
} from '@aiappnest/domain';
import { DataPaths, resolveDataRoot } from './paths';
import { migrate } from './migrations';
import { guard, repository, type RepositorySpec } from './repository';
import { schemas } from './schemas';
export { DataPaths, resolveDataRoot } from './paths';
export type { Repository, Page } from './repository';

type Key<T, K extends keyof T> = Pick<T, K>;
type AppScope = { appId: AppId };
/** Product code constructs this only in Service Host. No connection escapes this boundary. */
export class Storage {
  readonly paths: DataPaths;
  private readonly db: DatabaseSync;
  private depth = 0;
  private closed = false;
  readonly apps;
  readonly revisions;
  readonly skills;
  readonly appSkills;
  readonly conversations;
  readonly runs;
  readonly messages;
  readonly events;
  readonly memories;
  readonly memoryLinks;
  readonly artifacts;
  readonly providers;
  readonly grants;

  constructor(root = resolveDataRoot()) {
    this.paths = new DataPaths(root);
    this.db = guard(() => {
      this.paths.initialize();
      for (const suffix of ['', '-wal', '-shm']) this.paths.assertManaged(`${this.paths.database}${suffix}`);
      const db = new DatabaseSync(this.paths.database);
      try {
        db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL');
        if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal'
          || db.prepare('PRAGMA busy_timeout').get()?.timeout !== 3000 || db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) throw new DomainError('STORAGE_UNAVAILABLE', 'SQLite settings unavailable');
        migrate(db);
        return db;
      } catch (error) { db.close(); throw error; }
    });
    const make = <T, K, S>(table: string, schema: RepositorySpec['schema'], keys: string[], scope: string[], order: string, extra: Partial<RepositorySpec> = {}) => repository<T,K,S>(this.db, { table, schema, keys, scope, order, ...extra });
    this.apps = make<App, Key<App,'id'>, Record<string,never>>('apps', schemas.apps, ['id'], [], 'createdAt,id');
    this.revisions = make<AppRevision, Key<AppRevision,'id'|'appId'>, AppScope>('app_revisions', schemas.revisions, ['id','appId'], ['appId'], 'revision', { json: ['config'] });
    this.skills = make<Skill, Key<Skill,'id'|'version'>, Record<string,never>>('skills', schemas.skills, ['id','version'], [], 'id,version', { json: ['metadata'], validate: value => {
      const expected = relative(this.paths.root, this.paths.skill(value.id as Skill['id'], value.version as string)).split(sep).join('/');
      if (value.sourcePath !== expected) throw new DomainError('INVALID_INPUT');
    } });
    this.appSkills = make<AppSkill, Key<AppSkill,'revisionId'|'skillId'>, Key<AppSkill,'revisionId'>>('app_skills', schemas.appSkills, ['revisionId','skillId'], ['revisionId'], 'skillId', { boolean: ['enabled'] });
    this.conversations = make<Conversation, Key<Conversation,'id'|'appId'>, AppScope>('conversations', schemas.conversations, ['id','appId'], ['appId'], 'createdAt,id', { validate: value => {
      if (value.piSessionFile !== null) this.validateSessionFile(value.appId as AppId, value.id as ConversationId, value.piSessionFile as string);
    } });
    this.runs = make<Run, Key<Run,'id'|'appId'>, Key<Run,'appId'|'conversationId'>>('runs', schemas.runs, ['id','appId'], ['appId','conversationId'], 'createdAt,id', { json: ['usage'], nullableJson: ['usage'] });
    this.messages = make<Message, Key<Message,'id'|'appId'>, Key<Message,'appId'|'conversationId'>>('messages', schemas.messages, ['id','appId'], ['appId','conversationId'], 'createdAt,id');
    this.events = make<RunEvent, Key<RunEvent,'runId'|'seq'>, Key<RunEvent,'runId'>>('run_events', schemas.events, ['runId','seq'], ['runId'], 'seq', { json: ['payload'] });
    this.memories = make<Memory, Key<Memory,'id'|'appId'|'version'>, AppScope>('memories', schemas.memories, ['id','appId','version'], ['appId'], 'id,version');
    this.memoryLinks = make<RunMemoryLink, Key<RunMemoryLink,'runId'|'memoryId'|'memoryVersion'>, Key<RunMemoryLink,'runId'>>('run_memory_links', schemas.memoryLinks, ['runId','memoryId','memoryVersion'], ['runId'], 'memoryId,memoryVersion');
    this.artifacts = make<Artifact, Key<Artifact,'id'|'appId'>, Key<Artifact,'appId'|'conversationId'>>('artifacts', schemas.artifacts, ['id','appId'], ['appId','conversationId'], 'createdAt,id', { validate: value => {
      if (value.relativePath !== this.paths.artifact(value.appId as AppId, value.conversationId as ConversationId, value.id as Artifact['id'])) throw new DomainError('INVALID_INPUT');
      this.paths.assertManaged(join(this.paths.root, value.relativePath as string));
    } });
    this.providers = make<ProviderProfile, Key<ProviderProfile,'id'>, Record<string,never>>('provider_profiles', schemas.providers, ['id'], [], 'createdAt,id', { json: ['settings'] });
    this.grants = make<Grant, Key<Grant,'id'|'appId'>, AppScope>('grants', schemas.grants, ['id','appId'], ['appId'], 'createdAt,id');
  }

  /** Synchronous only. Nested operations use savepoints; never await inside this callback. */
  transaction<T>(action: () => T extends PromiseLike<unknown> ? never : T): T {
    return guard(() => {
      if (action.constructor.name === 'AsyncFunction') throw new DomainError('INVALID_INPUT', 'Transactions require synchronous callbacks');
      const level = this.depth++;
      const savepoint = `nested_${level}`;
      let began = false;
      try {
        this.db.exec(level ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'); began = true;
        const result = action();
        if (result && typeof (result as { then?: unknown }).then === 'function') throw new DomainError('INVALID_INPUT', 'Transactions require synchronous callbacks');
        this.db.exec(level ? `RELEASE ${savepoint}` : 'COMMIT');
        return result as T;
      } catch (error) {
        if (began) this.db.exec(level ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        throw error;
      } finally { this.depth--; }
    });
  }
  publishRevision(revision: AppRevision, bindings: AppSkill[], expectedAppVersion: number): AppRevision {
    return this.transaction(() => {
      const app = this.apps.get({ id: revision.appId });
      if (app.version !== expectedAppVersion) throw new DomainError('VERSION_CONFLICT');
      for (const binding of bindings) {
        if (binding.revisionId !== revision.id) throw new DomainError('OWNERSHIP_MISMATCH');
        this.appSkills.insert(binding);
      }
      const result = this.revisions.insert(revision);
      this.db.prepare("UPDATE apps SET currentRevisionId=?,status='ready',version=version+1,updatedAt=? WHERE id=?").run(revision.id, revision.createdAt, app.id);
      return result;
    });
  }
  updateApp(appId: AppId, expectedVersion: number, changes: Pick<App,'name'|'description'|'icon'|'status'>, at = timestamp()): App {
    return this.transaction(() => {
      const app = this.apps.get({ id: appId });
      if (app.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT');
      const parsed = schemas.apps.safeParse({ ...app, ...changes, updatedAt: at, version: app.version + 1 });
      if (!parsed.success || Object.keys(changes).some(key => !['name','description','icon','status'].includes(key))) throw new DomainError('INVALID_INPUT');
      const value = parsed.data;
      this.db.prepare('UPDATE apps SET name=?,description=?,icon=?,status=?,updatedAt=?,version=version+1 WHERE id=?').run(value.name,value.description,value.icon,value.status,at,appId);
      return this.apps.get({ id: appId });
    });
  }
  private validateSessionFile(appId: AppId, conversationId: ConversationId, file: string): void {
    const directory = this.paths.conversation(appId, conversationId, 'sessions');
    const rel = relative(directory, file);
    if (!isAbsolute(file) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !file.endsWith('.jsonl')) throw new DomainError('INVALID_INPUT');
    this.paths.assertManaged(file);
  }
  attachSessionFile(appId: AppId, conversationId: ConversationId, file: string): Conversation {
    return this.transaction(() => {
      const conversation = this.conversations.get({ appId, id: conversationId });
      this.validateSessionFile(appId, conversationId, file);
      if (conversation.piSessionFile !== null && conversation.piSessionFile !== file) throw new DomainError('VERSION_CONFLICT');
      this.db.prepare('UPDATE conversations SET piSessionFile=?,updatedAt=? WHERE id=?').run(file, timestamp(), conversationId);
      return this.conversations.get({ appId, id: conversationId });
    });
  }
  archiveConversation(appId: AppId, conversationId: ConversationId): void {
    this.transaction(() => {
      this.conversations.get({ id: conversationId, appId });
      if (this.db.prepare("SELECT 1 FROM runs WHERE conversationId=? AND state IN ('queued','starting','running','waiting_approval','cancelling')").get(conversationId)) throw new DomainError('INVALID_TRANSITION');
      this.db.prepare("UPDATE conversations SET status='archived',updatedAt=? WHERE id=?").run(timestamp(), conversationId);
    });
  }
  /** Dedupe scope is the trusted conversation + requestId; no second execution is created. */
  createRun(run: Run): Run {
    return this.transaction(() => {
      if (!schemas.runs.safeParse(run).success) throw new DomainError('INVALID_INPUT');
      const conversation = this.conversations.get({ id: run.conversationId, appId: run.appId });
      const existing = this.db.prepare('SELECT id FROM runs WHERE conversationId=? AND requestId=?').get(run.conversationId, run.requestId);
      if (existing) return this.runs.get({ id: existing.id as RunId, appId: run.appId });
      if (conversation.status !== 'active') throw new DomainError('INVALID_TRANSITION');
      return this.runs.insert(run);
    });
  }
  transitionRun(appId: AppId, runId: RunId, expectedVersion: number, next: RunState, at: Timestamp = timestamp(), error: string | null = null, usage: Run['usage'] = null): Run {
    return this.transaction(() => {
      const run = this.runs.get({ id: runId, appId });
      if (run.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT');
      assertRunTransition(run.state, next);
      const terminal = terminalRunStates.includes(next);
      const phase = terminal ? 'completed' : next === 'starting' ? 'started' : next === 'cancelling' ? run.phase : 'accepted';
      const candidate = { ...run, state: next, phase, version: run.version + 1, startedAt: next === 'starting' ? at : run.startedAt, endedAt: terminal ? at : null, error, usage };
      if (!schemas.runs.safeParse(candidate).success) throw new DomainError('INVALID_INPUT');
      this.db.prepare('UPDATE runs SET state=?,phase=?,version=version+1,startedAt=?,endedAt=?,error=?,usage=? WHERE id=? AND version=?')
        .run(next,phase,candidate.startedAt,candidate.endedAt,error,usage === null ? null : JSON.stringify(usage),runId,expectedVersion);
      return this.runs.get({ id: runId, appId });
    });
  }
  appendEvent(appId: AppId, runId: RunId, type: string, payload: unknown, at = timestamp()): RunEvent {
    return this.transaction(() => {
      this.runs.get({ id: runId, appId });
      const seq = this.db.prepare('SELECT coalesce(max(seq),0)+1 AS seq FROM run_events WHERE runId=?').get(runId)!.seq as number;
      return this.events.insert({ runId, seq, type, payload, createdAt: at });
    });
  }
  updateMessage(appId: AppId, messageId: Message['id'], content: string, status: Message['status']): Message {
    return this.transaction(() => {
      const message = this.messages.get({ id: messageId, appId });
      assertMessageTransition(message.status,status);
      if (!schemas.messages.safeParse({ ...message, content, status }).success) throw new DomainError('INVALID_INPUT');
      this.db.prepare('UPDATE messages SET content=?,status=? WHERE id=?').run(content,status,messageId);
      return this.messages.get({ id: messageId, appId });
    });
  }
  finishRun(appId: AppId, runId: RunId, expectedVersion: number, state: RunState, message: Message, at = timestamp()): Run {
    return this.transaction(() => {
      if (!terminalRunStates.includes(state) || message.status !== 'complete') throw new DomainError('INVALID_INPUT');
      if (message.appId !== appId || message.runId !== runId) throw new DomainError('OWNERSHIP_MISMATCH');
      const run = this.transitionRun(appId, runId, expectedVersion, state, at);
      const existing = this.db.prepare('SELECT id FROM messages WHERE id=?').get(message.id);
      if (existing) {
        const projected = this.messages.get({ id: message.id, appId });
        if (projected.conversationId !== message.conversationId || projected.runId !== runId || projected.role !== message.role || projected.createdAt !== message.createdAt) throw new DomainError('OWNERSHIP_MISMATCH');
        this.updateMessage(appId,message.id,message.content,'complete');
      } else this.messages.insert(message);
      this.appendEvent(appId, runId, 'run.completed', { state }, at);
      return run;
    });
  }
  reviseMemory(value: Memory, expectedVersion: number): Memory {
    return this.transaction(() => {
      const previous = this.memories.get({ id: value.id, appId: value.appId, version: expectedVersion });
      if (value.version !== expectedVersion + 1 || previous.createdAt !== value.createdAt || value.updatedAt < previous.updatedAt) throw new DomainError('VERSION_CONFLICT');
      return this.memories.insert(value);
    });
  }
  activeMemories(appId: AppId, at: Timestamp = timestamp()): Memory[] {
    return guard(() => {
      this.apps.get({ id: appId }); timestamp(at);
      const rows = this.db.prepare(`SELECT id,version FROM memories m WHERE appId=? AND status='active' AND (expiresAt IS NULL OR expiresAt>?)
        AND version=(SELECT max(version) FROM memories WHERE id=m.id) ORDER BY updatedAt DESC,id LIMIT 1000`).all(appId, at);
      return rows.map(row => this.memories.get({ appId, id: row.id as Memory['id'], version: row.version as number }));
    });
  }
  close(): void {
    if (this.closed) return;
    if (this.depth) throw new DomainError('INVALID_INPUT', 'Cannot close during a transaction');
    guard(() => this.db.close()); this.closed = true;
  }
  settings(): { foreignKeys: number; journalMode: string; busyTimeout: number; synchronous: number } {
    return guard(() => ({ foreignKeys: this.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys as number,
      journalMode: this.db.prepare('PRAGMA journal_mode').get()!.journal_mode as string,
      busyTimeout: this.db.prepare('PRAGMA busy_timeout').get()!.timeout as number,
      synchronous: this.db.prepare('PRAGMA synchronous').get()!.synchronous as number }));
  }
}
