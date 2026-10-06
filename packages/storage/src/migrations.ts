import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@aiappnest/domain';

export interface Migration { version: number; name: string; sql: string }
// Identifiers and transition literals below are source-controlled, never request data.
const time = (name: string, nullable = false) => `${name} INTEGER ${nullable ? '' : 'NOT NULL'} CHECK (${name} BETWEEN 0 AND 8640000000000000)`;
const immutable = (table: string) => `
CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable'); END;`;
export const migrations: readonly Migration[] = [{ version: 1, name: 'initial-domain', sql: `
CREATE TABLE provider_profiles (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, endpoint TEXT NOT NULL, secretRef TEXT,
 settings TEXT NOT NULL CHECK(json_valid(settings)), ${time('createdAt')}
) STRICT;
CREATE TABLE apps (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
 status TEXT NOT NULL CHECK(status IN ('draft','ready','archived')), currentRevisionId TEXT,
 version INTEGER NOT NULL CHECK(version >= 1), ${time('createdAt')}, ${time('updatedAt')},
 CHECK(status != 'ready' OR currentRevisionId IS NOT NULL),
 FOREIGN KEY(currentRevisionId,id) REFERENCES app_revisions(id,appId)
) STRICT;
CREATE TABLE app_revisions (
 id TEXT PRIMARY KEY, appId TEXT NOT NULL REFERENCES apps(id), revision INTEGER NOT NULL CHECK(revision >= 1),
 providerProfileId TEXT NOT NULL REFERENCES provider_profiles(id), config TEXT NOT NULL CHECK(json_valid(config)),
 roleText TEXT NOT NULL, runtimeVersion TEXT NOT NULL, ${time('createdAt')}, UNIQUE(id,appId), UNIQUE(appId,revision)
) STRICT;
CREATE TABLE skills (
 id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL CHECK(length(hash)=64), sourcePath TEXT NOT NULL,
 metadata TEXT NOT NULL CHECK(json_valid(metadata)), ${time('importedAt')}, PRIMARY KEY(id,version)
) STRICT;
CREATE TABLE app_skills (
 revisionId TEXT NOT NULL REFERENCES app_revisions(id) DEFERRABLE INITIALLY DEFERRED, skillId TEXT NOT NULL, skillVersion TEXT NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), PRIMARY KEY(revisionId,skillId),
 FOREIGN KEY(skillId,skillVersion) REFERENCES skills(id,version)
) STRICT;
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, appId TEXT NOT NULL REFERENCES apps(id), revisionId TEXT NOT NULL, title TEXT NOT NULL,
 piSessionFile TEXT, status TEXT NOT NULL CHECK(status IN ('active','archived')), ${time('createdAt')}, ${time('updatedAt')},
 UNIQUE(id,appId), FOREIGN KEY(revisionId,appId) REFERENCES app_revisions(id,appId)
) STRICT;
CREATE TABLE runs (
 id TEXT PRIMARY KEY, appId TEXT NOT NULL, conversationId TEXT NOT NULL, requestId TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','starting','running','waiting_approval','cancelling','succeeded','failed','cancelled','interrupted','handled')),
 phase TEXT NOT NULL CHECK(phase IN ('created','started','accepted','completed')), version INTEGER NOT NULL CHECK(version>=1),
 ${time('createdAt')}, ${time('startedAt', true)}, ${time('endedAt', true)}, error TEXT, usage TEXT CHECK(usage IS NULL OR json_valid(usage)),
 UNIQUE(conversationId,requestId), UNIQUE(id,conversationId,appId), UNIQUE(id,appId),
 FOREIGN KEY(conversationId,appId) REFERENCES conversations(id,appId),
 CHECK((state IN ('succeeded','failed','cancelled','interrupted','handled')) = (endedAt IS NOT NULL)),
 CHECK((phase='completed') = (endedAt IS NOT NULL)),
 CHECK(state='queued' OR state='cancelled' OR startedAt IS NOT NULL), CHECK(state!='queued' OR startedAt IS NULL),
 CHECK(startedAt IS NULL OR startedAt>=createdAt), CHECK(endedAt IS NULL OR endedAt>=coalesce(startedAt,createdAt)),
 CHECK((state='queued' AND phase='created') OR (state='starting' AND phase='started') OR
       (state IN ('running','waiting_approval') AND phase='accepted') OR (state='cancelling' AND phase IN ('started','accepted')) OR phase='completed')
) STRICT;
CREATE UNIQUE INDEX runs_one_active ON runs(conversationId) WHERE state IN ('starting','running','waiting_approval','cancelling');
CREATE TABLE messages (
 id TEXT PRIMARY KEY, appId TEXT NOT NULL, conversationId TEXT NOT NULL, runId TEXT,
 role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')), content TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('streaming','complete','failed')), ${time('createdAt')},
 UNIQUE(id,appId), UNIQUE(id,conversationId,appId), UNIQUE(id,runId,conversationId,appId),
 FOREIGN KEY(conversationId,appId) REFERENCES conversations(id,appId),
 FOREIGN KEY(runId,conversationId,appId) REFERENCES runs(id,conversationId,appId)
) STRICT;
CREATE TABLE run_events (
 runId TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL CHECK(seq>=1), type TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload)), ${time('createdAt')}, PRIMARY KEY(runId,seq)
) STRICT;
CREATE TABLE memories (
 id TEXT NOT NULL, appId TEXT NOT NULL REFERENCES apps(id), version INTEGER NOT NULL CHECK(version>=1),
 type TEXT NOT NULL CHECK(type IN ('preference','fact','convention','term')), content TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('candidate','active','conflict','disabled','deleted')),
 confidence REAL CHECK(confidence BETWEEN 0 AND 1), sourceConversationId TEXT, sourceRunId TEXT, sourceMessageId TEXT,
 ${time('createdAt')}, ${time('updatedAt')}, ${time('expiresAt', true)}, PRIMARY KEY(id,version), UNIQUE(id,version,appId),
 FOREIGN KEY(sourceConversationId,appId) REFERENCES conversations(id,appId),
 FOREIGN KEY(sourceRunId,appId) REFERENCES runs(id,appId), FOREIGN KEY(sourceMessageId,appId) REFERENCES messages(id,appId),
 FOREIGN KEY(sourceRunId,sourceConversationId,appId) REFERENCES runs(id,conversationId,appId),
 FOREIGN KEY(sourceMessageId,sourceConversationId,appId) REFERENCES messages(id,conversationId,appId),
 FOREIGN KEY(sourceMessageId,sourceRunId,sourceConversationId,appId) REFERENCES messages(id,runId,conversationId,appId),
 CHECK(sourceRunId IS NULL OR sourceConversationId IS NOT NULL), CHECK(sourceMessageId IS NULL OR sourceConversationId IS NOT NULL)
) STRICT;
CREATE TABLE run_memory_links (
 runId TEXT NOT NULL, appId TEXT NOT NULL, memoryId TEXT NOT NULL, memoryVersion INTEGER NOT NULL,
 injectedTextHash TEXT NOT NULL CHECK(length(injectedTextHash)=64), PRIMARY KEY(runId,memoryId,memoryVersion),
 FOREIGN KEY(runId,appId) REFERENCES runs(id,appId), FOREIGN KEY(memoryId,memoryVersion,appId) REFERENCES memories(id,version,appId)
) STRICT;
CREATE TABLE artifacts (
 id TEXT PRIMARY KEY, appId TEXT NOT NULL, conversationId TEXT NOT NULL, runId TEXT NOT NULL,
 relativePath TEXT NOT NULL UNIQUE, mimeType TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0),
 hash TEXT NOT NULL CHECK(length(hash)=64), ${time('createdAt')},
 FOREIGN KEY(runId,conversationId,appId) REFERENCES runs(id,conversationId,appId)
) STRICT;
CREATE TABLE grants (
 id TEXT PRIMARY KEY, appId TEXT NOT NULL REFERENCES apps(id), capability TEXT NOT NULL, resource TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('read','write','execute')), ${time('createdAt')}, UNIQUE(appId,capability,resource,mode)
) STRICT;
CREATE INDEX conversations_app ON conversations(appId,createdAt,id);
CREATE INDEX messages_conversation ON messages(conversationId,createdAt,id);
CREATE INDEX messages_run ON messages(runId);
CREATE INDEX runs_conversation ON runs(conversationId,createdAt,id);
CREATE INDEX memories_app ON memories(appId,status,expiresAt,id,version);
CREATE INDEX artifacts_conversation ON artifacts(conversationId,createdAt,id);
CREATE INDEX artifacts_run ON artifacts(runId);
CREATE INDEX revisions_provider ON app_revisions(providerProfileId);
CREATE INDEX app_skills_skill ON app_skills(skillId,skillVersion);
CREATE INDEX links_memory ON run_memory_links(memoryId,memoryVersion);
CREATE INDEX memories_source_conversation ON memories(sourceConversationId);
CREATE INDEX memories_source_run ON memories(sourceRunId);
CREATE INDEX memories_source_message ON memories(sourceMessageId);
${immutable('app_revisions')}
${immutable('skills')}
${immutable('app_skills')}
${immutable('memories')}
${immutable('run_events')}
${immutable('run_memory_links')}
CREATE TRIGGER app_skills_sealed BEFORE INSERT ON app_skills
 WHEN EXISTS(SELECT 1 FROM app_revisions WHERE id=NEW.revisionId)
 BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER conversation_binding BEFORE UPDATE OF appId,revisionId,id ON conversations
 BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER memory_version BEFORE INSERT ON memories BEGIN
 SELECT CASE WHEN NEW.version != coalesce((SELECT max(version)+1 FROM memories WHERE id=NEW.id),1) THEN RAISE(ABORT, 'version conflict') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM memories WHERE id=NEW.id AND appId!=NEW.appId) THEN RAISE(ABORT, 'ownership mismatch') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM memories WHERE id=NEW.id AND (createdAt!=NEW.createdAt OR updatedAt>NEW.updatedAt)) THEN RAISE(ABORT, 'version conflict') END;
END;
CREATE TRIGGER message_binding BEFORE UPDATE OF id,appId,conversationId,runId,role,createdAt ON messages
 BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER message_transition BEFORE UPDATE ON messages WHEN OLD.status!='streaming'
 BEGIN SELECT RAISE(ABORT, 'invalid transition'); END;
CREATE TRIGGER run_binding BEFORE UPDATE OF id,appId,conversationId,requestId,createdAt ON runs BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER run_initial BEFORE INSERT ON runs WHEN NEW.state!='queued' OR NEW.phase!='created' OR NEW.version!=1
 BEGIN SELECT RAISE(ABORT, 'invalid transition'); END;
CREATE TRIGGER run_transition BEFORE UPDATE ON runs BEGIN
 SELECT CASE WHEN NEW.version!=OLD.version+1 THEN RAISE(ABORT, 'version conflict') END;
 -- Frozen v1 graph: future domain transitions require a new migration, never edit this history.
 SELECT CASE WHEN NOT (
   (OLD.state='queued' AND NEW.state IN ('starting','cancelled')) OR
   (OLD.state='starting' AND NEW.state IN ('running','failed','cancelling','interrupted','handled')) OR
   (OLD.state='running' AND NEW.state IN ('waiting_approval','cancelling','succeeded','failed','interrupted')) OR
   (OLD.state='waiting_approval' AND NEW.state IN ('running','cancelling','failed','interrupted')) OR
   (OLD.state='cancelling' AND NEW.state IN ('cancelled','interrupted'))
 ) THEN RAISE(ABORT, 'invalid transition') END;
 SELECT CASE WHEN OLD.startedAt IS NOT NULL AND NEW.startedAt IS NOT OLD.startedAt THEN RAISE(ABORT, 'immutable') END;
END;
CREATE TRIGGER event_sequence BEFORE INSERT ON run_events
 WHEN NEW.seq!=coalesce((SELECT max(seq)+1 FROM run_events WHERE runId=NEW.runId),1)
 BEGIN SELECT RAISE(ABORT, 'version conflict'); END;
` }, { version: 2, name: 'provider-configuration', sql: `
ALTER TABLE provider_profiles RENAME COLUMN provider TO providerType;
ALTER TABLE provider_profiles ADD COLUMN name TEXT NOT NULL DEFAULT 'Imported provider';
ALTER TABLE provider_profiles ADD COLUMN modelId TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_profiles ADD COLUMN authMode TEXT NOT NULL DEFAULT 'none' CHECK(authMode IN ('api-key','none'));
ALTER TABLE provider_profiles ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1);
ALTER TABLE provider_profiles ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0 CHECK(updatedAt BETWEEN 0 AND 8640000000000000);
UPDATE provider_profiles SET updatedAt=createdAt, authMode=CASE WHEN secretRef IS NULL THEN 'none' ELSE 'api-key' END;
CREATE TRIGGER provider_revision BEFORE UPDATE ON provider_profiles BEGIN
 SELECT CASE WHEN NEW.revision!=OLD.revision+1 OR NEW.id!=OLD.id OR NEW.createdAt!=OLD.createdAt THEN RAISE(ABORT, 'version conflict') END;
END;
` }, { version: 3, name: 'application-drafts-and-snapshots', sql: `
CREATE TABLE app_drafts (
 appId TEXT PRIMARY KEY REFERENCES apps(id), config TEXT NOT NULL CHECK(json_valid(config)),
 category TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
 lastOpenedAt INTEGER CHECK(lastOpenedAt BETWEEN 0 AND 8640000000000000)
) STRICT;
CREATE TABLE revision_snapshots (
 revisionId TEXT PRIMARY KEY, appId TEXT NOT NULL, configHash TEXT NOT NULL CHECK(length(configHash)=64),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 FOREIGN KEY(revisionId,appId) REFERENCES app_revisions(id,appId)
) STRICT;
${immutable('revision_snapshots')}
CREATE TRIGGER archived_run BEFORE INSERT ON runs WHEN (SELECT status FROM apps WHERE id=NEW.appId)='archived'
 BEGIN SELECT RAISE(ABORT, 'invalid transition'); END;
CREATE TRIGGER archived_conversation BEFORE INSERT ON conversations WHEN (SELECT status FROM apps WHERE id=NEW.appId)='archived'
 BEGIN SELECT RAISE(ABORT, 'invalid transition'); END;
CREATE TRIGGER archive_active BEFORE UPDATE OF status ON apps WHEN NEW.status='archived' AND EXISTS(
 SELECT 1 FROM runs WHERE appId=NEW.id AND state IN ('queued','starting','running','waiting_approval','cancelling'))
 BEGIN SELECT RAISE(ABORT, 'invalid transition'); END;
` }, { version: 4, name: 'skill-import-registry', sql: `
CREATE TABLE skill_registry (
 id TEXT NOT NULL, version TEXT NOT NULL, detail TEXT NOT NULL CHECK(json_valid(detail)),
 PRIMARY KEY(id,version), FOREIGN KEY(id,version) REFERENCES skills(id,version)
) STRICT;
CREATE TRIGGER skill_registry_immutable_update BEFORE UPDATE ON skill_registry BEGIN SELECT RAISE(ABORT, 'immutable'); END;
DROP TRIGGER skills_immutable_delete;
CREATE TRIGGER skills_referenced_delete BEFORE DELETE ON skills WHEN EXISTS(
 SELECT 1 FROM app_skills WHERE skillId=OLD.id AND skillVersion=OLD.version)
 BEGIN SELECT RAISE(ABORT, 'ownership mismatch'); END;
` }];

export function migrate(db: DatabaseSync, steps: readonly Migration[] = migrations): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, appliedAt INTEGER NOT NULL) STRICT`);
    const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    if (applied.length > steps.length) throw new DomainError('STORAGE_UNAVAILABLE', 'Database schema is newer than this application');
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.version !== i + 1) throw new DomainError('STORAGE_UNAVAILABLE', 'Migrations must be contiguous');
      const checksum = createHash('sha256').update(step.sql).digest('hex');
      const previous = applied[i];
      if (previous) {
        if (previous.version !== step.version || previous.name !== step.name || previous.checksum !== checksum) throw new DomainError('STORAGE_UNAVAILABLE', 'Migration history mismatch');
      } else {
        db.exec(step.sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(step.version, step.name, checksum, Date.now());
      }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new DomainError('STORAGE_UNAVAILABLE', 'Foreign key validation failed');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
