import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@aiappnest/domain';
import type { DataJob } from '../../contracts/src/data';

export type Scope={appId:string;conversationId?:string};
export class MaintenanceStore {
  constructor(private db:DatabaseSync,private transaction:<T>(fn:()=>T)=>T) {}
  jobs() { return this.db.prepare('SELECT value FROM data_jobs ORDER BY rowid DESC').all().map(r=>JSON.parse(String(r.value)) as DataJob); }
  job(id:string) { const row=this.db.prepare('SELECT * FROM data_jobs WHERE id=?').get(id);if(!row) throw new DomainError('NOT_FOUND');return {job:JSON.parse(String(row.value)) as DataJob,plan:JSON.parse(String(row.plan))}; }
  save(job:DataJob,plan:unknown) { this.db.prepare('INSERT INTO data_jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,plan=excluded.plan').run(job.id,JSON.stringify(job),JSON.stringify(plan)); }
  scope(s:Scope) {
    if(!this.db.prepare('SELECT 1 FROM apps WHERE id=?').get(s.appId)) throw new DomainError('NOT_FOUND');
    if(s.conversationId && !this.db.prepare('SELECT 1 FROM conversations WHERE appId=? AND id=?').get(s.appId,s.conversationId)) throw new DomainError('NOT_FOUND');
    return this.db.prepare('SELECT id FROM conversations WHERE appId=?'+(s.conversationId?' AND id=?':'')).all(s.appId,...(s.conversationId?[s.conversationId]:[])).map(r=>String(r.id));
  }
  preview(s:Scope) {
    const ids=this.scope(s),count=(table:string,column='conversationId')=>Number(this.db.prepare(`SELECT count(*) n FROM ${table} WHERE appId=?${s.conversationId?` AND ${column}=?`:''}`).get(s.appId,...(s.conversationId?[s.conversationId]:[]))!.n);
    return {conversations:ids.length,attachments:count('attachments'),artifacts:count('artifacts'),memories:count('memories','sourceConversationId'),sharedSkills:Number(this.db.prepare('SELECT count(*) n FROM app_skills WHERE revisionId IN (SELECT id FROM app_revisions WHERE appId=?)').get(s.appId)!.n)};
  }
  list() {
    return [...this.db.prepare('SELECT r.appId,a.name,r.createdAt FROM app_recycle r JOIN apps a ON a.id=r.appId').all(),
      ...this.db.prepare('SELECT r.appId,r.conversationId,c.title name,r.createdAt FROM conversation_recycle r JOIN conversations c ON c.id=r.conversationId WHERE NOT EXISTS(SELECT 1 FROM app_recycle a WHERE a.appId=r.appId)').all()] as unknown as {appId:string;conversationId?:string;name:string;createdAt:number}[];
  }
  recycled(s:Scope) {return !!this.db.prepare(s.conversationId?'SELECT 1 FROM conversation_recycle WHERE appId=? AND conversationId=?':'SELECT 1 FROM app_recycle WHERE appId=?').get(s.appId,...(s.conversationId?[s.conversationId]:[]));}
  tombstone(s:Scope) {return !!this.db.prepare('SELECT 1 FROM source_tombstones WHERE appId=? AND conversationId=?').get(s.appId,s.conversationId??'');}
  record(operation:string,error:string|null=null) {this.db.prepare('INSERT INTO data_operations(operation,error,createdAt) VALUES(?,?,?)').run(operation,error,Date.now());}
  move(s:Scope) {
    this.transaction(()=>{
      if(this.tombstone(s))throw new DomainError('INVALID_INPUT');
      const ids=this.scope(s);
      if(this.db.prepare("SELECT 1 FROM runs WHERE appId=? AND endedAt IS NULL"+(s.conversationId?' AND conversationId=?':'')).get(s.appId,...(s.conversationId?[s.conversationId]:[]))) throw new DomainError('BUSY');
      if(!s.conversationId) {
        this.db.prepare('INSERT OR IGNORE INTO app_recycle SELECT id,status,? FROM apps WHERE id=?').run(Date.now(),s.appId);
        this.db.prepare("UPDATE apps SET status='archived',version=version+1,updatedAt=? WHERE id=?").run(Date.now(),s.appId);
      }
      for(const cid of ids) {
        if(!s.conversationId && this.db.prepare("SELECT 1 FROM conversations WHERE id=? AND status='archived'").get(cid))continue;
        this.db.prepare('INSERT OR IGNORE INTO conversation_recycle VALUES(?,?,?,?)').run(cid,s.appId,s.conversationId?'chat-and-attachments;preserve-memory;preserve-artifacts':'app-recycle',Date.now());
        this.db.prepare("UPDATE conversations SET status='archived' WHERE id=?").run(cid);
      }
      this.record('recycle.move');
    });
  }
  restore(s:Scope) {
    this.transaction(()=>{
      if(this.tombstone(s)) throw new DomainError('INVALID_INPUT');
      if(!this.recycled(s)) throw new DomainError('NOT_FOUND');
      for(const j of this.jobs()) if(j.kind==='delete' && j.state!=='succeeded' && this.job(j.id).plan.scope.appId===s.appId) throw new DomainError('BUSY');
      if(!s.conversationId) {
        this.db.prepare('UPDATE apps SET status=(SELECT previousStatus FROM app_recycle WHERE appId=?),version=version+1,updatedAt=? WHERE id=?').run(s.appId,Date.now(),s.appId);
        this.db.prepare('DELETE FROM app_recycle WHERE appId=?').run(s.appId);
      } else if(this.db.prepare('SELECT 1 FROM app_recycle WHERE appId=?').get(s.appId)) throw new DomainError('BUSY');
      for(const cid of this.scope(s)) {
        if(!s.conversationId && !this.db.prepare("SELECT 1 FROM conversation_recycle WHERE conversationId=? AND scope='app-recycle'").get(cid))continue;
        this.db.prepare("UPDATE conversations SET status='active' WHERE id=? AND EXISTS(SELECT 1 FROM conversation_recycle WHERE conversationId=?)").run(cid,cid);
        this.db.prepare('DELETE FROM conversation_recycle WHERE conversationId=?').run(cid);
      }
      this.record('recycle.restore');
    });
  }
  /** One transaction; immutable audit rows can only be removed inside this maintenance operation. */
  purge(s:Scope,deleteMemories:boolean,deleteArtifacts:boolean) {
    this.transaction(()=>{
      this.db.exec('UPDATE cleanup_guard SET enabled=1');
      const cids=this.scope(s),args=[s.appId,...(s.conversationId?[s.conversationId]:[])];
      const where='appId=?'+(s.conversationId?' AND sourceConversationId=?':'');
      const memories=`SELECT id FROM memories WHERE ${where}`;
      this.db.prepare(`DELETE FROM memory_supersedes WHERE memoryId IN (${memories}) OR supersedesId IN (${memories})`).run(...args,...args);
      this.db.prepare(`DELETE FROM memory_candidates WHERE memoryId IN (${memories})`).run(...args);
      if(deleteMemories) {
        this.db.prepare(`DELETE FROM run_memory_links WHERE memoryId IN (${memories})`).run(...args);
        this.db.prepare(`DELETE FROM search_documents WHERE kind='memory' AND id IN (${memories})`).run(...args);
        this.db.prepare(`DELETE FROM memories WHERE ${where}`).run(...args);
      } else this.db.prepare(`UPDATE memories SET sourceMessageId=NULL,sourceRunId=NULL WHERE ${where}`).run(...args);
      for(const cid of cids) {
        // Candidate provenance must not retain deleted message content or foreign keys.
        this.db.prepare('DELETE FROM memory_candidates WHERE taskId IN (SELECT id FROM extraction_tasks WHERE sourceConversationId=?)').run(cid);
        this.db.prepare('DELETE FROM extraction_tasks WHERE sourceConversationId=?').run(cid);
        for(const table of ['run_attachments','run_memory_links','run_events']) this.db.prepare(`DELETE FROM ${table} WHERE runId IN (SELECT id FROM runs WHERE conversationId=?)`).run(cid);
        for(const table of ['attachments','messages','policy_records','chat_trials','conversation_recycle']) this.db.prepare(`DELETE FROM ${table} WHERE conversationId=?`).run(cid);
        if(deleteArtifacts) this.db.prepare('DELETE FROM artifacts WHERE conversationId=?').run(cid);
        this.db.prepare('DELETE FROM runs WHERE conversationId=? AND id NOT IN (SELECT runId FROM artifacts)').run(cid);
        const keep=this.db.prepare('SELECT 1 FROM memories WHERE sourceConversationId=? UNION ALL SELECT 1 FROM artifacts WHERE conversationId=? LIMIT 1').get(cid,cid);
        if(keep) {
          this.db.prepare("UPDATE conversations SET title='Deleted source',piSessionFile=NULL,status='archived' WHERE id=?").run(cid);
          this.db.prepare('INSERT OR IGNORE INTO source_tombstones VALUES(?,?,?)').run(s.appId,cid,Date.now());
        } else { this.db.prepare('DELETE FROM source_tombstones WHERE conversationId=?').run(cid);this.db.prepare('DELETE FROM conversations WHERE id=?').run(cid); }
      }
      if(!s.conversationId) {
        this.db.prepare('DELETE FROM grants WHERE appId=?').run(s.appId);
        this.db.prepare('DELETE FROM app_recycle WHERE appId=?').run(s.appId);
        const keep=this.db.prepare('SELECT 1 FROM conversations WHERE appId=? UNION ALL SELECT 1 FROM memories WHERE appId=? LIMIT 1').get(s.appId,s.appId);
        if(keep) {
          this.db.prepare("UPDATE apps SET name='Deleted source',description='',status='archived',version=version+1 WHERE id=?").run(s.appId);
          this.db.prepare('INSERT OR IGNORE INTO source_tombstones VALUES(?,?,?)').run(s.appId,'',Date.now());
        }
        else {
          this.db.prepare('UPDATE apps SET currentRevisionId=NULL WHERE id=?').run(s.appId);
          this.db.prepare('DELETE FROM app_skills WHERE revisionId IN (SELECT id FROM app_revisions WHERE appId=?)').run(s.appId);
          for(const table of ['revision_snapshots','app_revisions','app_drafts','apps']) this.db.prepare(`DELETE FROM ${table} WHERE ${table==='apps'?'id':'appId'}=?`).run(s.appId);
        }
      }
      this.db.exec('UPDATE cleanup_guard SET enabled=0');
      if(this.db.prepare('PRAGMA foreign_key_check').all().length) throw new DomainError('STORAGE_UNAVAILABLE');
      this.record('recycle.purge-metadata');
    });
  }
}
