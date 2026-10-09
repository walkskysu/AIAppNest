import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,cpSync,symlinkSync,linkSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {DataService,BackupService,backupLimits,selectedDataRoot,switchDataRoot,fixture,runtime,ok,until,RunScheduler,Storage,AppService,ProviderService,PolicyService,PiAdapter} from './fixtures/engine-harness.mjs';
import {ServiceManager} from '../../dist/service-manager.cjs';

const hash=x=>createHash('sha256').update(x).digest('hex');
const scope=f=>({appId:f.app.id,conversationId:f.conversation.id});
function directory(t,name='新目录 中文 空格'){const p=mkdtempSync(resolve('.test-data-'+name+'-'));t.after(()=>rmSync(p,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return p;}
function client(t,f,options={},fault=()=>{}){
  const s=new RunScheduler(f.services,runtime,options);f.schedulers.push(s);const data=new DataService(f.storage,s,()=>0,fault),owner=randomUUID();t.after(()=>data.close());
  const request=r=>data.request({operation:'request',owner,request:r});
  const select=(purpose,path)=>ok(data.request({operation:'select',owner,purpose,path})).token;
  const wait=async job=>{await until(()=>!['waiting','copying','verifying'].includes(f.storage.maintenance.job(job.id).job.state));return f.storage.maintenance.job(job.id).job;};
  const submit=(text='hello')=>ok(s.request({operation:'submit',...scope(f),revisionId:f.conversation.revisionId,requestId:randomUUID(),text,attachmentIds:[]})).run;
  return {s,data,owner,request,select,wait,submit};
}
async function packageFixture(t,opts={}){
  const f=await fixture(t,{skillBody:'A durable backup skill',files:true,fileFlow:true,permissions:{mode:'controlled-files',tools:['write']},...opts}),c=client(t,f),out=directory(t);
  const source=join(f.root,'original.txt');writeFileSync(source,'中文附件 bytes 123');
  const owner=randomUUID(),selected=ok(await f.services.files.request({operation:'select',...scope(f),owner,path:source})).selection;
  const attachment=ok(await f.services.files.request({operation:'request',owner,request:{operation:'attachments.import',...scope(f),token:selected.token}})).reply.file;
  const grant=f.policyRequest({operation:'grants.create',resource:'output',access:'write',confirmation:'never'}).grant;
  const run=ok(c.s.request({operation:'submit',...scope(f),revisionId:f.conversation.revisionId,requestId:randomUUID(),text:JSON.stringify({grantId:grant.id}),attachmentIds:[attachment.id]})).run;
  await until(()=>f.storage.runs.get({appId:f.app.id,id:run.id}).endedAt!==null);
  assert.equal(f.storage.runs.get({appId:f.app.id,id:run.id}).state,'succeeded');
  const artifact=f.storage.artifacts.list(scope(f))[0];assert.ok(artifact);
  const memory={id:randomUUID(),appId:f.app.id,version:1,type:'fact',content:'备份来源记忆',status:'active',priority:0,confidence:null,sourceConversationId:f.conversation.id,sourceRunId:run.id,sourceMessageId:null,createdAt:Date.now(),updatedAt:Date.now(),expiresAt:null};f.storage.memories.insert(memory);
  mkdirSync(join(f.storage.paths.root,'credentials'));writeFileSync(join(f.storage.paths.root,'credentials','secret.bin'),'MACHINE_CIPHERTEXT');
  const agent=f.storage.paths.conversation(f.app.id,f.conversation.id,'agent');mkdirSync(agent,{recursive:true});writeFileSync(join(agent,'auth.json'),'PLAINTEXT_SECRET');
  const token=c.select('backup',out),job=await c.wait(ok(c.request({operation:'backups.create',token})).job);assert.equal(job.state,'succeeded',JSON.stringify(job));
  return {f,c,out,job,source,artifact,attachment,memory,run};
}

test('B01 drain real scheduler and WAL, deny admission, cancel while waiting and resume after fault',async t=>{
  const f=await fixture(t);let finish;
  const c=client(t,f,{prepare:()=>({model:'fixture',local:false,roots:[],exclusive:false,text:'x',snapshot:{}}),open:async()=>({prompt:()=>new Promise(r=>finish=r),close:async()=>{},getMessages:async()=>[],abort:async()=>{}})});
  const run=c.submit();await until(()=>!!finish);
  const parent=directory(t),token=c.select('backup',parent),job=ok(c.request({operation:'backups.create',token})).job;
  assert.equal(job.state,'waiting');assert.equal(c.s.request({operation:'submit',...scope(f),revisionId:f.conversation.revisionId,requestId:randomUUID(),text:'blocked',attachmentIds:[]}).ok,false);
  ok(c.request({operation:'backups.cancel',jobId:job.id}));assert.equal((await c.wait(job)).state,'cancelled');
  const second=ok(c.request({operation:'backups.create',token:c.select('backup',parent)})).job;assert.equal(second.state,'waiting');
  finish({runId:run.id,status:'succeeded',toolErrors:0,usage:null,cancellation:{requested:false,acknowledged:false,idle:true,forced:false,exited:false}});
  const result=await c.wait(second);assert.equal(result.state,'succeeded');
  const db=new DatabaseSync(join(result.output,'data/platform.db'),{readOnly:true});try{assert.equal(db.prepare('SELECT state FROM runs WHERE id=?').get(run.id).state,'succeeded');}finally{db.close();}
  assert.equal(c.data.busy,false);
});

test('B02/B03/B04 real Pi session + files + skill + memory restore to independent Chinese/spaced directory, rebind and continue exact session',async t=>{
  const {f,c,job,artifact,attachment,memory}=await packageFixture(t,{secret:'key-data-backup-fixture'});
  const manifest=JSON.parse(readFileSync(join(job.output,'manifest.json'),'utf8'));
  assert.ok(manifest.includesRecycle);assert.ok(!manifest.files.some(f=>/credentials|\/agent\//.test(f.path)));
  for(const file of manifest.files)for(const secret of ['key-data-backup-fixture','MACHINE_CIPHERTEXT','PLAINTEXT_SECRET'])assert.ok(!readFileSync(join(job.output,file.path)).includes(Buffer.from(secret)));
  const db=new DatabaseSync(join(job.output,'data/platform.db'));try{assert.equal(db.prepare('SELECT secretRef FROM provider_profiles').get().secretRef,null);}finally{db.close();}
  const parent=directory(t),result=await c.wait(ok(c.request({operation:'backups.restore',token:c.select('package',job.output),targetToken:c.select('restore',parent)})).job);
  assert.equal(result.state,'ready',JSON.stringify(result));const restored=new Storage(result.output);
  try {
    assert.equal(restored.memories.get({appId:f.app.id,id:memory.id,version:1}).content,memory.content);
    for(const file of [artifact,attachment])assert.equal(hash(readFileSync(join(result.output,file.relativePath??`apps/${f.app.id}/conversations/${f.conversation.id}/attachments/${file.id}`))),file.hash);
    const session=restored.conversations.get({appId:f.app.id,id:f.conversation.id}).piSessionFile;assert.ok(session.startsWith(result.output));assert.ok(!session.startsWith(f.root));
    assert.equal(readFileSync(session,'utf8').split('\n').slice(1).join('\n'),readFileSync(f.storage.conversations.get({appId:f.app.id,id:f.conversation.id}).piSessionFile,'utf8').split('\n').slice(1).join('\n'));
    assert.equal(restored.policyRecords('grant').length,0);
    const providers=new ProviderService(restored,{collect:()=>false,create:()=>`secret:${randomUUID()}`,read:()=> 'key-data-backup-fixture',remove:()=>{}}),apps=new AppService(restored,providers),snap=apps.readRevision(f.app.id,f.conversation.revisionId);
    assert.throws(()=>providers.snapshotRuntime(snap.snapshot.credentialBinding,snap.snapshot.provider));
    const p=restored.providers.list({})[0];ok(await providers.request({operation:'save',input:{id:p.id,expectedRevision:p.revision,config:snap.snapshot.provider,credential:{action:'replace',key:'key-data-backup-fixture'}}}));
    const policy=new PolicyService(restored,(a,r)=>apps.readRevision(a,r));
    let worker,scheduler;try {
      worker=await PiAdapter.restore({storage:restored,apps,providers,policy},runtime,f.app.id,f.conversation.id);assert.ok(worker);await worker.close(true);
      scheduler=new RunScheduler({storage:restored,apps,providers,policy},runtime);
      const run=ok(scheduler.request({operation:'submit',...scope(f),revisionId:f.conversation.revisionId,requestId:randomUUID(),text:'recall',attachmentIds:[]})).run;
      await until(()=>restored.runs.get({appId:f.app.id,id:run.id}).endedAt!==null);
      assert.equal(restored.runs.get({appId:f.app.id,id:run.id}).state,'succeeded');
      assert.ok(JSON.stringify(f.requests.at(-1).body.messages).includes('中文附件'));
      assert.equal(restored.conversations.get({appId:f.app.id,id:f.conversation.id}).piSessionFile,session);
    }finally{await scheduler?.close();await worker?.close(true);policy.close();}
  } finally{restored.close();}
});

test('B05 package validation rejects corrupt/missing/extra files, traversal, runtime and quota without touching live data',async t=>{
  const {f,job}=await packageFixture(t),service=new BackupService(f.storage),parent=directory(t),source=job.output;
  for(const mutate of [m=>{m.files[0].hash='0'.repeat(64);},m=>{m.files[0].path='../escape';},m=>{m.files[0].path='C:/escape';},m=>{m.files[0].path='apps/con.txt';},m=>{m.runtime.pi='999';},m=>{m.files.push({...m.files[0],path:m.files[0].path.toUpperCase()});}]) {
    const copy=join(parent,randomUUID());cpSync(source,copy,{recursive:true});const m=JSON.parse(readFileSync(join(copy,'manifest.json'),'utf8'));mutate(m);writeFileSync(join(copy,'manifest.json'),JSON.stringify(m));await assert.rejects(service.preflight(copy));
  }
  await assert.rejects(service.preflight(source,undefined,{...backupLimits,bytes:1}));
  const copy=join(parent,'missing');cpSync(source,copy,{recursive:true});rmSync(join(copy,'data/platform.db'));await assert.rejects(service.preflight(copy));
  const extra=join(parent,'extra');cpSync(source,extra,{recursive:true});writeFileSync(join(extra,'extra.txt'),'not listed');await assert.rejects(service.preflight(extra));
  assert.equal(f.storage.apps.get({id:f.app.id}).name,f.app.name);assert.ok(existsSync(f.storage.paths.database));
});

test('B04 Windows case aliases cannot include runtime credentials in a backup or restore package',async t=>{
  const {f,c,job}=await packageFixture(t),agent=f.storage.paths.conversation(f.app.id,f.conversation.id,'agent');
  // Rename through a distinct name so Windows changes the directory entry's case too.
  renameSync(agent,agent+'-rename');renameSync(agent+'-rename',agent.replace(/agent$/,'AGENT'));
  const backup=await c.wait(ok(c.request({operation:'backups.create',token:c.select('backup',directory(t))})).job);
  assert.equal(backup.state,'succeeded');
  const manifest=JSON.parse(readFileSync(join(backup.output,'manifest.json'),'utf8'));
  assert.ok(!manifest.files.some(file=>/\/agent\//i.test(file.path)));
  const path=`apps/${f.app.id}/conversations/${f.conversation.id}/AGENT/auth.json`,bytes=Buffer.from('PLAINTEXT_SECRET');
  mkdirSync(join(job.output,path,'..'),{recursive:true});writeFileSync(join(job.output,path),bytes);
  const malicious=JSON.parse(readFileSync(join(job.output,'manifest.json'),'utf8'));
  malicious.files.push({path,size:bytes.length,hash:hash(bytes)});writeFileSync(join(job.output,'manifest.json'),JSON.stringify(malicious));
  await assert.rejects(new BackupService(f.storage).preflight(job.output));
});

test('B02 restored unfinished runs require explicit retry and never replay when the new root starts',async t=>{
  const {f,c,job,run}=await packageFixture(t);
  const db=new DatabaseSync(join(job.output,'data/platform.db'));
  const queued=randomUUID(),active=randomUUID();
  try {
    const insert=db.prepare("INSERT INTO runs SELECT ?,appId,conversationId,?,'queued','created',1,createdAt,NULL,NULL,NULL,NULL FROM runs WHERE id=?");
    insert.run(active,randomUUID(),run.id);insert.run(queued,randomUUID(),run.id);
    db.prepare("UPDATE runs SET state='starting',phase='started',startedAt=createdAt,version=version+1 WHERE id=?").run(active);
    db.prepare("UPDATE runs SET state='running',phase='accepted',version=version+1 WHERE id=?").run(active);
  } finally {db.close();}
  const manifest=JSON.parse(readFileSync(join(job.output,'manifest.json'),'utf8')),file=manifest.files.find(f=>f.path==='data/platform.db'),bytes=readFileSync(join(job.output,file.path));
  file.hash=hash(bytes);file.size=bytes.length;writeFileSync(join(job.output,'manifest.json'),JSON.stringify(manifest));
  const result=await c.wait(ok(c.request({operation:'backups.restore',token:c.select('package',job.output),targetToken:c.select('restore',directory(t))})).job);
  assert.equal(result.state,'ready');const restored=new Storage(result.output);
  try {
    assert.equal(restored.runs.get({appId:f.app.id,id:active}).state,'interrupted');
    assert.equal(restored.runs.get({appId:f.app.id,id:queued}).state,'cancelled');
    assert.equal(restored.runs.get({appId:f.app.id,id:active}).error,'RESTORED_REQUIRES_RETRY');
    assert.equal(restored.unfinishedRuns().length,0);
  } finally {restored.close();}
  const requests=f.requests.length,manager=new ServiceManager({nodePath:runtime.node,entry:resolve('dist/service-host.cjs'),dataRoot:result.output});
  try {ok(await manager.start());await delay(150);assert.equal(f.requests.length,requests);}finally{await manager.stop();}
});

test('B05 links and hardlinks are rejected in source and restored package',async t=>{
  const {f,job}=await packageFixture(t),parent=directory(t),linked=join(parent,'linked');cpSync(job.output,linked,{recursive:true});
  const target=join(linked,'data/platform.db');rmSync(target);linkSync(join(job.output,'data/platform.db'),target);await assert.rejects(new BackupService(f.storage).preflight(linked));
  rmSync(target);symlinkSync(join(job.output,'data'),join(linked,'junction'),'junction');await assert.rejects(new BackupService(f.storage).preflight(linked));
});

test('B06 failed staging migration / publication leaves current root usable and no final package',async t=>{
  const {f,job}=await packageFixture(t),parent=directory(t),controller=new AbortController(),restoreJob={id:randomUUID(),kind:'restore',state:'copying',files:0,error:null,createdAt:Date.now()};
  const service=new BackupService(f.storage,p=>{if(p==='migration')throw Error('FAULT');});
  await assert.rejects(service.restore(job.output,parent,restoreJob,controller.signal,()=>{}));assert.equal(readdirSync(parent).length,0);
  const backupJob={...restoreJob,id:randomUUID(),kind:'backup'};await assert.rejects(new BackupService(f.storage,p=>{if(p==='publish')throw Error('FAULT');}).create(parent,backupJob,controller.signal,()=>{}));assert.equal(readdirSync(parent).length,0);
  assert.equal(f.storage.apps.get({id:f.app.id}).name,f.app.name);
});

test('B07 root pointer interrupted before commit selects old, after commit selects complete new; missing target falls back',async t=>{
  const {f,c,job}=await packageFixture(t),profile=directory(t),parent=directory(t);
  const restored=await c.wait(ok(c.request({operation:'backups.restore',token:c.select('package',job.output),targetToken:c.select('restore',parent)})).job);assert.equal(restored.state,'ready');
  assert.throws(()=>switchDataRoot(profile,f.storage.paths.root,restored.output,()=>{throw Error('POWER_LOSS');}));assert.equal(selectedDataRoot(profile,f.storage.paths.root),f.storage.paths.root);
  switchDataRoot(profile,f.storage.paths.root,restored.output);assert.equal(selectedDataRoot(profile,f.root),restored.output);
  writeFileSync(join(restored.output,'restore-ready.json'),'{truncated');assert.equal(selectedDataRoot(profile,f.storage.paths.root),f.storage.paths.root);
  rmSync(join(restored.output,'restore-ready.json'));assert.equal(selectedDataRoot(profile,f.storage.paths.root),f.storage.paths.root);
});

test('B08 recycle and restore conversation/app preserve independent recycle state and rebuild search',async t=>{
  const {f,c}=await packageFixture(t);ok(c.request({operation:'recycle.move',...scope(f)}));assert.equal(ok(c.request({operation:'recycle.list'})).items.length,1);
  ok(c.request({operation:'recycle.restore',...scope(f)}));assert.equal(f.storage.conversations.get({appId:f.app.id,id:f.conversation.id}).status,'active');
  assert.ok(f.storage.search.search(f.app.id,'Recovered','message','phrase',20,0).total>0);
  ok(c.request({operation:'recycle.move',...scope(f)}));ok(c.request({operation:'recycle.move',appId:f.app.id}));ok(c.request({operation:'recycle.restore',appId:f.app.id}));
  assert.equal(f.storage.conversations.get({appId:f.app.id,id:f.conversation.id}).status,'archived');
});

test('B09 purge all owned data removes raw sessions, attachment, artifact, indexes and orphan skill; external originals and backups remain',async t=>{
  const {f,c,source,job,artifact}=await packageFixture(t);const skill=f.storage.skills.list({})[0];ok(c.request({operation:'recycle.move',appId:f.app.id}));
  const deleted=await c.wait(ok(c.request({operation:'recycle.purge',appId:f.app.id,deleteMemories:true,deleteArtifacts:true,confirm:true})).job);
  assert.equal(deleted.state,'succeeded',JSON.stringify(deleted));assert.throws(()=>f.storage.apps.get({id:f.app.id}));assert.ok(!existsSync(join(f.storage.paths.root,'apps',f.app.id)));assert.ok(existsSync(source));assert.ok(existsSync(job.output));assert.ok(!existsSync(f.storage.paths.skill(skill.id,skill.version)));
  assert.equal(f.storage.search.search(f.app.id,'备份','memory','phrase',10,0).total,0);
});

test('B09 retained memory/artifact get valid tombstone ownership; shared skill remains',async t=>{
  const {f,c,artifact,memory}=await packageFixture(t);const skill=f.storage.skills.list({})[0];ok(c.request({operation:'recycle.move',...scope(f)}));
  const deleted=await c.wait(ok(c.request({operation:'recycle.purge',...scope(f),deleteMemories:false,deleteArtifacts:false,confirm:true})).job);assert.equal(deleted.state,'succeeded',JSON.stringify(deleted));
  assert.ok(existsSync(join(f.storage.paths.root,artifact.relativePath)));assert.ok(existsSync(f.storage.paths.skill(skill.id,skill.version)));
  const kept=f.storage.memories.get({appId:f.app.id,id:memory.id,version:1});assert.equal(kept.sourceRunId,null);assert.equal(kept.sourceConversationId,f.conversation.id);
  const source=f.storage.conversations.get({appId:f.app.id,id:f.conversation.id});assert.equal(source.title,'Deleted source');assert.equal(source.piSessionFile,null);assert.equal(f.storage.messages.list(scope(f)).length,0);
  assert.throws(()=>f.storage.recycleConversation(f.app.id,f.conversation.id));
  assert.equal(c.request({operation:'recycle.restore',...scope(f)}).ok,false);
});

test('B10 partial deletion fails visibly, removes future memory retrieval immediately; persisted plan retries after restart',async t=>{
  const {f,c}=await packageFixture(t);await c.data.close();let failed=false;
  const data=new DataService(f.storage,c.s,()=>0,p=>{if(p==='delete-file'&&!failed){failed=true;throw Error('ACCESS_DENIED');}}),owner=randomUUID();
  const request=r=>data.request({operation:'request',owner,request:r});ok(request({operation:'recycle.move',...scope(f)}));
  const job=await c.wait(ok(request({operation:'recycle.purge',...scope(f),deleteMemories:true,deleteArtifacts:true,confirm:true})).job);assert.equal(job.state,'failed');assert.equal(f.storage.activeMemories(f.app.id).length,0);
  assert.equal(request({operation:'recycle.restore',...scope(f)}).ok,false);await data.close();
  const restarted=new DataService(f.storage,c.s),retry=ok(restarted.request({operation:'request',owner,request:{operation:'recycle.retry',jobId:job.id}})).job;
  assert.equal((await c.wait(retry)).state,'succeeded');assert.throws(()=>f.storage.conversations.get({appId:f.app.id,id:f.conversation.id}));await restarted.close();
});

test('selection tokens bind owner, purpose, single use; stale jobs become interrupted without locking admission',async t=>{
  const f=await fixture(t),c=client(t,f),parent=directory(t),token=c.select('backup',parent);
  assert.equal(c.data.request({operation:'request',owner:randomUUID(),request:{operation:'backups.create',token}}).ok,false);
  assert.equal(c.request({operation:'backups.preflight',token}).ok,false);
  await c.wait(ok(c.request({operation:'backups.create',token})).job);assert.equal(c.request({operation:'backups.create',token}).ok,false);
  const stale={id:randomUUID(),kind:'backup',state:'copying',files:3,error:null,createdAt:Date.now()};f.storage.maintenance.save(stale,{});
  const restarted=new DataService(f.storage,c.s);assert.equal(f.storage.maintenance.job(stale.id).job.state,'interrupted');assert.equal(restarted.busy,false);
});

test('B05 manifest cannot omit referenced attachments, skills, revisions or sessions, even with matching hashes',async t=>{
  const {f,job}=await packageFixture(t),parent=directory(t),service=new BackupService(f.storage);
  for(const match of [p=>p.includes('/attachments/'),p=>p.startsWith('skills/'),p=>p.endsWith('/role.md'),p=>p.includes('/sessions/')]) {
    const copy=join(parent,randomUUID());cpSync(job.output,copy,{recursive:true});
    const manifest=JSON.parse(readFileSync(join(copy,'manifest.json'),'utf8')),file=manifest.files.find(f=>match(f.path));assert.ok(file);
    rmSync(join(copy,file.path));manifest.files=manifest.files.filter(f=>f!==file);writeFileSync(join(copy,'manifest.json'),JSON.stringify(manifest));
    await assert.rejects(service.preflight(copy));
  }
  const copy=join(parent,'duplicate-session');cpSync(job.output,copy,{recursive:true});const manifest=JSON.parse(readFileSync(join(copy,'manifest.json'),'utf8'));
  manifest.sessions.push(manifest.sessions[0]);writeFileSync(join(copy,'manifest.json'),JSON.stringify(manifest));await assert.rejects(service.preflight(copy));
});

test('B01 freeze waits for extraction and in-flight service writes; cancellation and copy failure release admission',async t=>{
  const f=await fixture(t,{memory:{enabled:true,automaticCandidates:true,maxItems:10,tokenBudget:1500}});let release;
  const c=client(t,f,{extract:(_task,_input,signal)=>new Promise(r=>{release=r;signal.addEventListener('abort',()=>r(JSON.stringify({candidates:[]})),{once:true});})}),parent=directory(t);c.submit('回答偏好：简短中文');await until(()=>!!release);
  const job=ok(c.request({operation:'backups.create',token:c.select('backup',parent)})).job;
  await delay(60);assert.equal(f.storage.maintenance.job(job.id).job.state,'waiting');assert.deepEqual(readdirSync(parent),[]);
  release(JSON.stringify({candidates:[]}));assert.equal((await c.wait(job)).state,'succeeded');
  await c.data.close();let writes=1;
  const data=new DataService(f.storage,c.s,()=>writes,p=>{if(p==='copy')throw Error('COPY_FAILED');}),owner=randomUUID();t.after(()=>data.close());
  const request=r=>data.request({operation:'request',owner,request:r});
  const token=ok(data.request({operation:'select',owner,purpose:'backup',path:parent})).token;
  const waiting=ok(request({operation:'backups.create',token})).job;await delay(50);assert.equal(f.storage.maintenance.job(waiting.id).job.state,'waiting');
  assert.equal(c.s.request({operation:'submit',...scope(f),revisionId:f.conversation.revisionId,requestId:randomUUID(),text:'blocked',attachmentIds:[]}).ok,false);
  writes=0;assert.equal((await c.wait(waiting)).state,'failed');assert.equal(data.busy,false);
  const run=c.submit();await until(()=>f.storage.runs.get({appId:f.app.id,id:run.id}).endedAt!==null);
});

test('B08/B09 ordinary unarchive cannot bypass recycle or retained app tombstone; another recycled app keeps shared Skill',async t=>{
  const {f,c}=await packageFixture(t),skill=f.storage.skills.list({})[0];
  let second=ok(f.apps.request({operation:'create',metadata:{...f.metadata,name:'Shared owner'}})).app;
  second=ok(f.apps.request({operation:'update',appId:second.id,expectedVersion:second.version,metadata:{...f.metadata,name:'Shared owner'},draft:f.app.draft})).app;
  second=ok(f.apps.request({operation:'publish',appId:second.id,expectedVersion:second.version})).app;
  ok(c.request({operation:'recycle.move',appId:second.id}));ok(c.request({operation:'recycle.move',appId:f.app.id}));
  assert.equal(f.apps.request({operation:'archive',appId:f.app.id,expectedVersion:f.storage.apps.get({id:f.app.id}).version,archived:false}).ok,false);
  const deleted=await c.wait(ok(c.request({operation:'recycle.purge',appId:f.app.id,deleteMemories:true,deleteArtifacts:true,confirm:true})).job);assert.equal(deleted.state,'succeeded');
  assert.ok(existsSync(f.storage.paths.skill(skill.id,skill.version)));ok(c.request({operation:'recycle.restore',appId:second.id}));
  assert.ok(f.apps.readRevision(second.id,second.currentRevisionId));
  const kept=await packageFixture(t);ok(kept.c.request({operation:'recycle.move',appId:kept.f.app.id}));
  const tombstone=await kept.c.wait(ok(kept.c.request({operation:'recycle.purge',appId:kept.f.app.id,deleteMemories:false,deleteArtifacts:false,confirm:true})).job);assert.equal(tombstone.state,'succeeded');
  assert.equal(kept.f.apps.request({operation:'archive',appId:kept.f.app.id,expectedVersion:kept.f.storage.apps.get({id:kept.f.app.id}).version,archived:false}).ok,false);
});

test('B10 cleanup retries after metadata commit and Skill file failure without losing the persisted deletion plan',async t=>{
  const {f,c}=await packageFixture(t);await c.data.close();const owner=randomUUID();let fail=true;
  const data=new DataService(f.storage,c.s,()=>0,p=>{if(p==='delete-skill'&&fail){fail=false;throw Error('LOCKED');}});
  const request=r=>data.request({operation:'request',owner,request:r});ok(request({operation:'recycle.move',appId:f.app.id}));
  const job=await c.wait(ok(request({operation:'recycle.purge',appId:f.app.id,deleteMemories:true,deleteArtifacts:true,confirm:true})).job);assert.equal(job.state,'failed');assert.throws(()=>f.storage.apps.get({id:f.app.id}));
  assert.equal(f.storage.maintenance.job(job.id).plan.metadataDone,true);await data.close();const restarted=new DataService(f.storage,c.s);
  const retried=ok(restarted.request({operation:'request',owner,request:{operation:'recycle.retry',jobId:job.id}})).job;assert.equal((await c.wait(retried)).state,'succeeded');await restarted.close();
});

test('production data IPC enforces freeze across services, persists status and restores to a new root',async t=>{
  const f=await fixture(t),parent=directory(t),owner=randomUUID(),options={nodePath:runtime.node,entry:resolve('dist/service-host.cjs'),dataRoot:f.storage.paths.root};let manager=new ServiceManager(options);
  try {
    ok(await manager.start());const request=r=>manager.data({operation:'request',owner,request:r});
    const select=async(purpose,path)=>ok(await manager.data({operation:'select',owner,purpose,path})).token;
    const run=ok(await manager.runs({operation:'submit',...scope(f),revisionId:f.conversation.revisionId,requestId:randomUUID(),text:'slow',attachmentIds:[]})).run;
    await until(()=>f.storage.runs.get({appId:f.app.id,id:run.id}).state==='running');
    const job=ok(await request({operation:'backups.create',token:await select('backup',parent)})).job;
    assert.equal((await manager.apps({operation:'create',metadata:f.metadata})).error.code,'BUSY');
    ok(await manager.runs({operation:'cancel',...scope(f),runId:run.id}));await until(()=>f.storage.maintenance.job(job.id).job.state==='succeeded');
    const saved=ok(await request({operation:'backups.status',jobId:job.id})).job;await manager.stop();manager=new ServiceManager(options);ok(await manager.start());
    assert.equal(ok(await request({operation:'backups.status',jobId:job.id})).job.state,'succeeded');
    const restored=ok(await request({operation:'backups.restore',token:await select('package',saved.output),targetToken:await select('restore',parent)})).job;
    await until(()=>f.storage.maintenance.job(restored.id).job.state==='ready');
    assert.equal(ok(await request({operation:'backups.activate',jobId:restored.id})).restartRequired,true);
    assert.equal((await manager.apps({operation:'create',metadata:f.metadata})).error.code,'BUSY');
  } finally {await manager.stop();}
});
