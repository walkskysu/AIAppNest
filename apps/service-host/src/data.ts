import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Storage, DataPaths } from '@aiappnest/storage';
import { DomainError, id } from '@aiappnest/domain';
import { publicError, type Result } from '@aiappnest/contracts';
import { dataHostRequestSchema, type DataReply, type DataJob, type DataRequest } from '../../../packages/contracts/src/data';
import { BackupService, removeManaged } from './backups';
import type { RunScheduler } from './runs';
import type { Scope } from '../../../packages/storage/src/maintenance';

/** All long operations are jobs: IPC never waits for a model, copy or deletion. */
export class DataService {
  private selections=new Map<string,{owner:string;purpose:string;path:string;expires:number}>();
  private active?:{job:DataJob;controller:AbortController;done:Promise<void>};
  private activating=false;
  readonly backups:BackupService;
  get busy(){return !!this.active || this.activating;}
  get waiting(){return this.active?.job.state==='waiting';}
  constructor(private storage:Storage,private runs:Pick<RunScheduler,'freeze'|'resume'|'retireConversation'|'unretireConversation'>,private pending:()=>number=()=>0,private fault:(point:string)=>void=()=>{}) {
    this.backups=new BackupService(storage,fault);
    for(const job of storage.maintenance.jobs()) if(['waiting','copying','verifying'].includes(job.state)) {job.state='interrupted';job.error='HOST_RESTART';storage.maintenance.save(job,storage.maintenance.job(job.id).plan);}
  }
  async close(){this.active?.controller.abort();await this.active?.done;}
  private take(token:string,owner:string,purpose:string,consume=true) {
    const s=this.selections.get(token);if(!s || s.owner!==owner || s.purpose!==purpose || s.expires<Date.now())throw new DomainError('FORBIDDEN');
    new DataPaths(s.path).assertManaged(s.path);if(consume)this.selections.delete(token);return s.path;
  }
  request(raw:unknown):Result<DataReply> {
    try {
      const input=dataHostRequestSchema.parse(raw);
      if(input.operation==='select') {
        const paths=new DataPaths(input.path);paths.assertManaged(paths.root);if(!lstatSync(paths.root).isDirectory())throw new DomainError('INVALID_INPUT');
        for(const [key,s] of this.selections)if(s.expires<Date.now())this.selections.delete(key);
        if(this.selections.size>=64)throw new DomainError('BUSY');
        const token=randomUUID();this.selections.set(token,{owner:input.owner,purpose:input.purpose,path:paths.root,expires:Date.now()+600000});return {ok:true,value:{operation:'select',token}};
      }
      return {ok:true,value:this.dispatch(input.request,input.owner)};
    } catch(error){return {ok:false,error:publicError(error instanceof DomainError && ['BUSY','NOT_FOUND','FORBIDDEN','INVALID_INPUT'].includes(error.code)?error.code as 'BUSY':'STORAGE_UNAVAILABLE')};}
  }
  private dispatch(r:DataRequest,owner:string):DataReply {
    const operation=r.operation;
    if(r.operation==='backups.status')return {operation,job:this.storage.maintenance.job(r.jobId).job};
    if(r.operation==='backups.cancel') {if(this.active?.job.id===r.jobId)this.active.controller.abort();return {operation,job:this.storage.maintenance.job(r.jobId).job};}
    if(this.busy)throw new DomainError('BUSY');
    if(r.operation==='backups.create') {
      if(this.storage.maintenance.jobs().some(j=>j.kind==='delete'&&j.state!=='succeeded'))throw new DomainError('BUSY');
      return {operation,job:this.start('backup',{parent:this.take(r.token,owner,'backup')})};
    }
    if(r.operation==='backups.preflight')return {operation,job:this.start('restore',{source:this.take(r.token,owner,'package',false),preflight:true})};
    if(r.operation==='backups.restore')return {operation,job:this.start('restore',{source:this.take(r.token,owner,'package'),parent:this.take(r.targetToken,owner,'restore')})};
    if(r.operation==='backups.activate') {
      const {job,plan}=this.storage.maintenance.job(r.jobId);if(job.kind!=='restore' || job.state!=='ready' || !job.output || plan.preflight)throw new DomainError('INVALID_INPUT');
      this.activating=true;return {operation,job,restartRequired:true};
    }
    if(r.operation==='recycle.list')return {operation,items:this.storage.maintenance.list(),jobs:this.storage.maintenance.jobs()};
    if(r.operation==='recycle.retry') {
      const {job,plan}=this.storage.maintenance.job(r.jobId);if(job.kind!=='delete' || !['failed','interrupted'].includes(job.state))throw new DomainError('INVALID_INPUT');
      return {operation,job:this.start('delete',plan,job)};
    }
    const scope:Scope={appId:r.appId,...(r.conversationId?{conversationId:r.conversationId}:{})};
    if(r.operation==='recycle.preview')return {operation,preview:this.storage.maintenance.preview(scope)};
    if(r.operation==='recycle.restore') {
      this.storage.maintenance.restore(scope);for(const cid of this.storage.maintenance.scope(scope))this.runs.unretireConversation(cid);
      this.storage.search.rebuild();return {operation};
    }
    if(this.storage.maintenance.tombstone(scope) || r.operation==='recycle.purge'&&!this.storage.maintenance.recycled(scope))throw new DomainError('INVALID_INPUT');
    let terminated=true;
    for(const cid of this.storage.maintenance.scope(scope))if(!this.runs.retireConversation(scope.appId,cid))terminated=false;
    if(!terminated)throw new DomainError('BUSY');
    if(r.operation==='recycle.move'){this.storage.maintenance.move(scope);return {operation};}
    if(!this.storage.maintenance.recycled(scope))throw new DomainError('INVALID_INPUT');
    // Only one outstanding cleanup per application. Retry retains its original selection.
    for(const job of this.storage.maintenance.jobs())if(job.kind==='delete' && job.state!=='succeeded' && this.storage.maintenance.job(job.id).plan.scope.appId===scope.appId)throw new DomainError('BUSY');
    return {operation,job:this.start('delete',{scope,deleteMemories:r.deleteMemories,deleteArtifacts:r.deleteArtifacts})};
  }
  private start(kind:DataJob['kind'],plan:any,previous?:DataJob) {
    const job:DataJob=previous?{...previous,state:'waiting',error:null}:{id:randomUUID(),kind,state:'waiting',files:0,error:null,createdAt:Date.now()};
    const controller=new AbortController(),save=()=>this.storage.maintenance.save(job,plan);
    save();const active={job,controller,done:Promise.resolve()};this.active=active;
    active.done=(async()=>{
      let frozen=false;
      try {
        await this.runs.freeze(controller.signal);frozen=true;
        while(this.pending()){controller.signal.throwIfAborted();await new Promise(r=>setTimeout(r,20));}
        job.state='copying';save();
        if(kind==='backup')job.output=await this.backups.create(plan.parent,job,controller.signal,save);
        else if(kind==='restore') {
          if(plan.preflight)await this.backups.preflight(plan.source,controller.signal);
          else job.output=await this.backups.restore(plan.source,plan.parent,job,controller.signal,save);
        } else await this.purge(plan,job,save);
        job.state=kind==='restore'&&!plan.preflight?'ready':'succeeded';job.error=null;
      }catch(error){job.state=controller.signal.aborted&&kind!=='delete'?'cancelled':'failed';job.error=job.state==='cancelled'?'CANCELLED':'DATA_OPERATION_FAILED';}
      finally{try{save();}finally{if(frozen)this.runs.resume();this.active=undefined;}}
    })();return {...job};
  }
  private async purge(plan:any,job:DataJob,save:()=>void) {
    const scope=plan.scope as Scope;
    if(!plan.paths) {
      const cids=this.storage.maintenance.scope(scope),paths:string[]=[];
      for(const cid of cids)for(const area of ['agent','sessions','workspace','attachments',...(plan.deleteArtifacts?['artifacts']:[])] as const)paths.push(join('apps',scope.appId,'conversations',cid,area));
      if(!scope.conversationId && plan.deleteArtifacts && plan.deleteMemories)paths.splice(0,paths.length,join('apps',scope.appId));
      plan.paths=paths;plan.skills=this.storage.appSkillsForCleanup(scope.appId);save();
    }
    // Remove source memories from retrieval before any fallible filesystem work.
    if(plan.deleteMemories)this.storage.forgetScope(scope);
    for(const path of plan.paths) {const target=join(this.storage.paths.root,path);this.fault('delete-file');removeManaged(this.storage.paths,target);job.files++;save();}
    if(!plan.metadataDone) {
      try{this.storage.transaction(()=>{this.storage.maintenance.purge(scope,plan.deleteMemories,plan.deleteArtifacts);plan.metadataDone=true;save();});}
      catch(error){delete plan.metadataDone;throw error;}
    }
    for(const binding of plan.skills) {
      try{this.storage.deleteSkill(id<'skill'>(binding.id),binding.version);}catch(error){if(error instanceof DomainError && error.code==='SKILL_IN_USE')continue;if(!(error instanceof DomainError && error.code==='NOT_FOUND'))throw error;}
      this.fault('delete-skill');removeManaged(this.storage.paths,this.storage.paths.skill(id<'skill'>(binding.id),binding.version));
    }
    this.storage.search.rebuild();
  }
}
