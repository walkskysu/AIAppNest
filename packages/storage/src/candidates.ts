import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@aiappnest/domain';

export interface ExtractionTask {
  id:string;appId:string;sourceConversationId:string;sourceRunId:string;sourceMessageId:string;sourceVersion:string;policyVersion:string;dedupeKey:string;
  state:'pending'|'running'|'succeeded'|'failed'|'cancelled';error:string|null;attempts:number;version:number;createdAt:number;updatedAt:number;
}
export class CandidateStore {
  constructor(private readonly db:DatabaseSync) {}
  get(appId:string,taskId:string):ExtractionTask {
    const row=this.db.prepare('SELECT * FROM extraction_tasks WHERE appId=? AND id=?').get(appId,taskId);
    if(!row) throw new DomainError('NOT_FOUND'); return row as unknown as ExtractionTask;
  }
  find(appId:string,dedupeKey:string) { return this.db.prepare('SELECT * FROM extraction_tasks WHERE appId=? AND dedupeKey=?').get(appId,dedupeKey) as unknown as ExtractionTask|undefined; }
  insert(t:ExtractionTask) {
    this.db.prepare('INSERT INTO extraction_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(t.id,t.appId,t.sourceConversationId,t.sourceRunId,t.sourceMessageId,t.sourceVersion,t.policyVersion,t.dedupeKey,t.state,t.error,t.attempts,t.version,t.createdAt,t.updatedAt);
  }
  transition(t:ExtractionTask,state:ExtractionTask['state'],error:string|null=null) {
    const result=this.db.prepare("UPDATE extraction_tasks SET state=?,error=?,version=version+1,attempts=attempts+?,updatedAt=? WHERE appId=? AND id=? AND version=?")
      .run(state,error,state==='running' ? 1:0,Date.now(),t.appId,t.id,t.version);
    if(!result.changes) throw new DomainError('VERSION_CONFLICT');return this.get(t.appId,t.id);
  }
  recover() { this.db.prepare("UPDATE extraction_tasks SET state='failed',error='INTERRUPTED',version=version+1,updatedAt=? WHERE state='running'").run(Date.now()); }
  pending() { return this.db.prepare("SELECT * FROM extraction_tasks WHERE state='pending' ORDER BY createdAt,id LIMIT 100").all() as unknown as ExtractionTask[]; }
  outstanding() { return Number(this.db.prepare("SELECT count(*) n FROM extraction_tasks WHERE state IN ('pending','running')").get()!.n); }
  tasks(appId:string,limit:number,offset:number) {
    return { total:Number(this.db.prepare('SELECT count(*) n FROM extraction_tasks WHERE appId=?').get(appId)!.n),
      tasks:this.db.prepare('SELECT * FROM extraction_tasks WHERE appId=? ORDER BY createdAt DESC,id LIMIT ? OFFSET ?').all(appId,limit,offset) as unknown as ExtractionTask[] };
  }
  attach(appId:string,memoryId:string,taskId:string,normalized:string,subject:string) {
    this.db.prepare('INSERT INTO memory_candidates(memoryId,appId,taskId,normalized,subject) VALUES(?,?,?,?,?)').run(memoryId,appId,taskId,normalized,subject);
  }
  metadata(appId:string,memoryId:string) {
    const row=this.db.prepare('SELECT taskId,subject,normalized FROM memory_candidates WHERE appId=? AND memoryId=?').get(appId,memoryId);
    if(!row) throw new DomainError('NOT_FOUND');return row as {taskId:string;subject:string;normalized:string};
  }
  duplicate(appId:string,normalized:string) {
    return !!this.db.prepare(`SELECT 1 FROM memories m WHERE appId=? AND status IN ('active','candidate','conflict')
      AND version=(SELECT max(version) FROM memories WHERE appId=m.appId AND id=m.id)
      AND (expiresAt IS NULL OR expiresAt>?) AND search_normalize(content)=? LIMIT 1`).get(appId,Date.now(),normalized);
  }
  list(appId:string,limit:number,offset:number) {
    const where="m.appId=? AND m.status IN ('candidate','conflict') AND m.version=(SELECT max(version) FROM memories WHERE appId=m.appId AND id=m.id)";
    return {total:Number(this.db.prepare('SELECT count(*) n FROM memories m WHERE '+where).get(appId)!.n),
      ids:this.db.prepare('SELECT id FROM memories m WHERE '+where+' ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?').all(appId,limit,offset).map(r=>r.id as string)};
  }
  supersede(appId:string,memoryId:string,version:number,oldId:string,oldVersion:number) {
    this.db.prepare('INSERT INTO memory_supersedes VALUES(?,?,?,?,?)').run(appId,memoryId,version,oldId,oldVersion);
  }
  history(appId:string,memoryId:string) {
    return this.db.prepare('SELECT supersedesId,supersedesVersion,version FROM memory_supersedes WHERE appId=? AND memoryId=? ORDER BY version,supersedesId').all(appId,memoryId).map(r=>({...r})) as {supersedesId:string;supersedesVersion:number;version:number}[];
  }
}
