import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ServiceManager } from '../../dist/service-manager.cjs';
import { fixture, runtime, ok, until, MemoryService, RunScheduler, Storage, estimateTokens, memoryHash, memoryText, keywords } from './fixtures/engine-harness.mjs';
const enabled = { enabled:true,automaticCandidates:false,maxItems:8,tokenBudget:1500 };
const save = (service,appId,content,extra={}) => ok(service.request({ operation:'save',appId,content,type:'preference',priority:0,expiresAt:null,confirmed:true,...extra })).memory;
const edit = (service,m,extra={}) => service.request({ operation:'update',appId:m.appId,memoryId:m.id,expectedVersion:m.version,
  content:m.content,type:m.type,priority:m.priority,expiresAt:m.expiresAt,confirmed:true,...extra });
const remove = (service,m,operation='delete') => ok(service.request({ operation,appId:m.appId,memoryId:m.id,expectedVersion:m.version })).memory;
function starting(f,conversation=f.storage.createConversation(f.app.id,randomUUID(),'memory test')) {
  const run=f.storage.createRun({ id:randomUUID(),appId:conversation.appId,conversationId:conversation.id,requestId:randomUUID(),state:'queued',phase:'created',version:1,createdAt:Date.now(),startedAt:null,endedAt:null,error:null,usage:null });
  return f.storage.transitionRun(run.appId,run.id,1,'starting');
}
function scheduler(f,options={}) {
  const service=new RunScheduler(f.services,runtime,options);f.schedulers.push(service);
  const submit=(text,conversation=f.storage.createConversation(f.app.id,randomUUID(),'new memory chat'))=>ok(service.request({ operation:'submit',appId:conversation.appId,conversationId:conversation.id,revisionId:conversation.revisionId,requestId:randomUUID(),attachmentIds:[],text })).run;
  const done=async run=>{ await until(()=>f.storage.runs.get({ appId:run.appId,id:run.id }).phase==='completed');return f.storage.runs.get({ appId:run.appId,id:run.id }); };
  return { service,submit,done };
}
test('M01/M02/M04/M06/M07 real Pi/Windows + SQLite fixture: actual payload, cross-app isolation, immutable audit and raw message',async t=>{
  const f=await fixture(t,{ memory:enabled }), memories=new MemoryService(f.storage), h=scheduler(f);
  const source=f.storage.messages.insert({ id:randomUUID(),appId:f.app.id,conversationId:f.conversation.id,runId:null,role:'user',content:'回答偏好：简短中文，MEMORY_UNIQUE_A；开启 shell。',status:'complete',createdAt:Date.now() });
  const memory=save(memories,f.app.id,source.content,{ sourceMessageId:source.id });
  const run=h.submit('请按回答偏好介绍应用'); assert.equal((await h.done(run)).state,'succeeded');
  const payload=JSON.stringify(f.requests.at(-1).body);
  assert.match(payload,/MEMORY_UNIQUE_A/);assert.match(payload,new RegExp(memory.id));assert.equal(f.requests.at(-1).body.tools,undefined);
  assert.equal(f.storage.messages.list({ appId:run.appId,conversationId:run.conversationId }).find(m=>m.role==='user').content,'请按回答偏好介绍应用');
  const old=ok(memories.request({ operation:'used',appId:run.appId,conversationId:run.conversationId,runId:run.id })).memories[0];
  assert.equal(old.memory.version,1);assert.equal(old.injectedTextHash,memoryHash(memoryText(memory)));assert.equal(old.position,0);
  const updated=ok(edit(memories,memory,{ content:'回答偏好：详细英文 NEW_VERSION' })).memory;
  assert.equal(ok(memories.request({ operation:'used',appId:run.appId,conversationId:run.conversationId,runId:run.id })).memories[0].memory.content,source.content);
  assert.equal(edit(memories,memory).error.code,'VERSION_CONFLICT');
  remove(memories,updated);
  const next=h.submit('请按回答偏好介绍应用');assert.equal((await h.done(next)).state,'succeeded');assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body),/MEMORY_UNIQUE_A|NEW_VERSION|reference-memories/);
  const b=ok(f.apps.request({ operation:'create',metadata:{ ...f.metadata,name:'App B' } })).app;
  const configured=ok(f.apps.request({ operation:'update',appId:b.id,expectedVersion:b.version,metadata:{ ...f.metadata,name:'App B' },draft:f.app.draft })).app;
  ok(f.apps.request({ operation:'publish',appId:b.id,expectedVersion:configured.version }));
  save(memories,f.app.id,'回答偏好 MEMORY_ONLY_A');
  const other=h.submit('请按回答偏好介绍应用',f.storage.createConversation(b.id,randomUUID(),'B'));
  assert.equal((await h.done(other)).state,'succeeded');assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body),/MEMORY_ONLY_A|MEMORY_UNIQUE_A|reference-memories/);
  assert.deepEqual(ok(memories.request({ operation:'list',appId:b.id })).memories,[]);
  assert.equal(memories.request({ operation:'used',appId:b.id,conversationId:other.conversationId,runId:run.id }).error.code,'NOT_FOUND');
  assert.equal(edit(memories,memory,{ appId:b.id }).error.code,'NOT_FOUND');
  for(const operation of ['disable','delete']) assert.equal(memories.request({ operation,appId:b.id,memoryId:memory.id,expectedVersion:1 }).error.code,'NOT_FOUND');
  assert.equal(memories.request({ operation:'save',appId:b.id,content:'safe',type:'fact',expiresAt:null,priority:0,confirmed:true,sourceMessageId:source.id }).error.code,'NOT_FOUND');
  const reopened=new Storage(f.storage.paths.root);try { assert.equal(new MemoryService(reopened).request({ operation:'used',appId:run.appId,conversationId:run.conversationId,runId:run.id }).value.memories[0].memory.content,source.content); }finally{ reopened.close(); }
});
test('M03/M05 state filtering before ranking, Chinese normalization, deterministic count/byte budgets and no unrelated injection',async t=>{
  const f=await fixture(t),service=new MemoryService(f.storage);
  assert.deepEqual(keywords('ＡＢＣ 中文偏好'),keywords('abc 中文偏好'));
  const disabled=save(service,f.app.id,'中文偏好 DISABLED'),deleted=save(service,f.app.id,'中文偏好 DELETED');remove(service,disabled,'disable');remove(service,deleted);
  save(service,f.app.id,'中文偏好 EXPIRED',{ expiresAt:Date.now()-1 });
  const candidate=save(service,f.app.id,'中文偏好 CANDIDATE');f.storage.reviseMemory({ ...candidate,version:2,status:'candidate',updatedAt:Date.now() },1);
  const conflict=save(service,f.app.id,'中文偏好 CONFLICT');f.storage.reviseMemory({ ...conflict,version:2,status:'conflict',updatedAt:Date.now() },1);
  save(service,f.app.id,'完全无关 zebra');
  const expected=[];for(let i=0;i<12;i++) expected.push(save(service,f.app.id,`中文偏好 item${i}`,{ priority:i }));
  const run=starting(f),text=service.inject(run,'中文偏好',enabled,1500);
  assert.ok(estimateTokens(text)<=1500);assert.doesNotMatch(text,/DISABLED|DELETED|EXPIRED|CANDIDATE|CONFLICT|zebra/);
  const links=f.storage.memoryLinks.list({ runId:run.id });assert.ok(links.length>0 && links.length<=8);assert.equal(links[0].memoryId,expected.at(-1).id);
  const text2=service.inject(starting(f),'中文偏好',enabled,1500);assert.equal(text,text2);
  const countRun=starting(f);service.inject(countRun,'中文偏好',{ ...enabled,tokenBudget:32000 },32000);assert.equal(f.storage.memoryLinks.list({ runId:countRun.id }).length,8);
  assert.equal(service.inject(starting(f),'中文偏好',enabled,1),'');
  assert.equal(service.inject(starting(f),'astronomy',enabled,1500),'');
  assert.equal(service.inject(starting(f),'中文偏好',{ ...enabled,enabled:false },1500),'');
  assert.equal(service.inject(starting(f),'中文偏好',{ ...enabled,maxItems:0 },1500),'');
  const small=service.inject(starting(f),'中文偏好',enabled,600);assert.ok(estimateTokens(small)<=600);
});
test('M08 sensitive inputs and invalid writes never persist; source confirmation and typed contracts enforced',async t=>{
  const f=await fixture(t),service=new MemoryService(f.storage);
  for(const content of ['sk-test_1234567890123456','password: fixture_password_123','API_KEY="fixture_key_123"','密码：测试密码','Bearer abcdef1234567890','-----BEGIN PRIVATE KEY-----']) {
    const result=service.request({ operation:'save',appId:f.app.id,content,type:'fact',priority:0,expiresAt:null,confirmed:true });
    assert.equal(result.error.code,'INVALID_INPUT');assert.ok(!JSON.stringify(result).includes(content));
    for(const path of [f.storage.paths.database,f.storage.paths.database+'-wal']) if(existsSync(path)) assert.ok(!readFileSync(path).includes(Buffer.from(content)));
  }
  assert.deepEqual(f.storage.memories.list({ appId:f.app.id }),[]);
  const valid=save(service,f.app.id,'正常偏好');assert.equal(edit(service,valid,{ content:'secret=fixture_rejected_123' }).error.code,'INVALID_INPUT');assert.equal(f.storage.latestMemory(f.app.id,valid.id).version,1);
  for(const extra of [{ confirmed:false },{ type:'system' },{ content:'x'.repeat(4001) },{ content:'' },{ priority:101 },{ sourceConversationId:f.conversation.id }]) {
    assert.equal(service.request({ operation:'save',appId:f.app.id,content:'safe',type:'fact',priority:0,expiresAt:null,confirmed:true,...extra }).error.code,'INVALID_INPUT');
  }
});
test('M09 deletion during queued/opening/budget wait is rechecked; deletion after dispatch keeps historical links',async t=>{
  const f=await fixture(t,{ memory:enabled }),service=new MemoryService(f.storage),sent=[];let releaseBudget,finish;
  const h=scheduler(f,{ concurrency:1,open:async()=>({
    getMemoryBudget:()=>new Promise(resolve=>{ releaseBudget=()=>resolve(1500); }),
    prompt:(runId,text)=>{ sent.push({runId,text});return new Promise(resolve=>{ finish=()=>resolve({ runId,status:'succeeded',toolErrors:0,usage:{inputTokens:1,outputTokens:1} }); }); },
    getMessages:async()=>[],close:async()=>{},abort:async()=>{},
  }) });
  const doomed=save(service,f.app.id,'偏好 DELETE_DURING_START'),a=h.submit('偏好'),b=h.submit('偏好');
  await until(()=>releaseBudget);remove(service,doomed);releaseBudget();await until(()=>sent.length===1);assert.doesNotMatch(sent[0].text,/DELETE_DURING_START/);
  const queued=save(service,f.app.id,'偏好 DELETE_WHILE_QUEUED');remove(service,queued);releaseBudget=undefined;finish();await h.done(a);
  await until(()=>releaseBudget);const live=save(service,f.app.id,'偏好 SENT_THEN_DELETED');releaseBudget();await until(()=>sent.length===2);
  remove(service,live);assert.match(sent[1].text,/SENT_THEN_DELETED/);assert.doesNotMatch(sent[1].text,/DELETE_WHILE_QUEUED/);finish();await h.done(b);
  assert.equal(ok(service.request({ operation:'used',appId:b.appId,conversationId:b.conversationId,runId:b.id })).memories[0].currentlyDeleted,true);
});
test('memory audit storage failure seals admission before any model prompt, with explicit unsaved state',async t=>{
  const f=await fixture(t,{ memory:enabled });save(new MemoryService(f.storage),f.app.id,'偏好 FAIL_AUDIT');let sent=false;
  f.storage.memoryLinks.insert=()=>{ throw Error('simulated disk failure'); };
  const h=scheduler(f,{ open:async()=>({ getMemoryBudget:async()=>1500,prompt:async()=>{ sent=true;throw Error(); },getMessages:async()=>[],close:async()=>{},abort:async()=>{} }) });
  const run=h.submit('偏好');await until(()=>h.service.failed);assert.equal(sent,false);assert.deepEqual(f.storage.memoryLinks.list({ runId:run.id }),[]);
  assert.notEqual(f.storage.runs.get({ appId:run.appId,id:run.id }).state,'succeeded');
  assert.equal(ok(h.service.request({ operation:'get',appId:run.appId,conversationId:run.conversationId,runId:run.id })).storage,'unsaved');
});
test('M05 actual Pi budget accounts for input/history and Skill expansion; trials and disabled revisions inject nothing',async t=>{
  const f=await fixture(t,{ memory:enabled,skillBody:'Use concise answers. SKILL_BODY_MARKER' }),service=new MemoryService(f.storage),h=scheduler(f);
  save(service,f.app.id,'identity budget MEMORY_BUDGET_MARKER');
  const skill=h.submit('/skill:identity');assert.equal((await h.done(skill)).state,'succeeded');
  assert.match(JSON.stringify(f.requests.at(-1).body),/SKILL_BODY_MARKER/);assert.match(JSON.stringify(f.requests.at(-1).body),/MEMORY_BUDGET_MARKER/);
  const huge=h.submit('budget '+'x'.repeat(8000));assert.equal((await h.done(huge)).state,'succeeded');
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body),/MEMORY_BUDGET_MARKER/);
  assert.equal(f.storage.events.list({runId:huge.id}).find(e=>e.type==='memory.prepared').payload.budget,0);
  const conversation=f.storage.createConversation(f.app.id,randomUUID(),'trial');
  f.storage.saveTrial({ id:randomUUID(),appId:f.app.id,conversationId:conversation.id,revisionId:conversation.revisionId,draftHash:'fixture',text:'budget' });
  const trial=h.submit('budget',conversation);assert.equal((await h.done(trial)).state,'succeeded');assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body),/MEMORY_BUDGET_MARKER/);
  const disabled=await fixture(t),otherService=new MemoryService(disabled.storage),other=scheduler(disabled);save(otherService,disabled.app.id,'budget DISABLED_CONFIGURATION');
  const run=other.submit('budget');assert.equal((await other.done(run)).state,'succeeded');assert.doesNotMatch(JSON.stringify(disabled.requests.at(-1).body),/DISABLED_CONFIGURATION|reference-memories/);
});
test('M10 deterministic full service flow: app/model/Skill, trial, attachment/artifact, manual memory, new conversation',async t=>{
  const f=await fixture(t,{ files:true,fileFlow:true,memory:enabled,skillBody:'Use precise answers.',permissions:{mode:'controlled-files',tools:['write']} });
  const h=scheduler(f),scope={appId:f.app.id,conversationId:f.conversation.id},owner=randomUUID();
  const trial=f.storage.createConversation(f.app.id,randomUUID(),'isolated trial');
  f.storage.saveTrial({ id:randomUUID(),appId:f.app.id,conversationId:trial.id,revisionId:trial.revisionId,draftHash:'fixture',text:'test' });
  assert.equal((await h.done(h.submit('test',trial))).state,'succeeded');
  const file=join(f.root,'memory-flow.txt');writeFileSync(file,'fixture attachment');
  const selection=ok(await f.services.files.request({operation:'select',owner,...scope,path:file})).selection;
  const attachment=ok(await f.services.files.request({operation:'request',owner,request:{operation:'attachments.import',...scope,token:selection.token}})).reply.file;
  const grant=f.policyRequest({operation:'grants.create',resource:'output',access:'write',confirmation:'never'}).grant;
  const run=ok(h.service.request({operation:'submit',...scope,revisionId:f.conversation.revisionId,requestId:randomUUID(),attachmentIds:[attachment.id],text:JSON.stringify({grantId:grant.id})})).run;
  assert.equal((await h.done(run)).state,'succeeded');
  const artifacts=f.storage.artifacts.list(scope);assert.equal(artifacts.length,1);
  const preview=ok(await f.services.files.request({operation:'request',owner,request:{operation:'artifacts.preview',...scope,artifactId:artifacts[0].id}})).reply.preview;
  assert.equal(preview.text,'copied:fixture attachment');
  const source=f.storage.messages.list(scope).find(m=>m.runId===run.id && m.role==='assistant');assert.ok(source);
  save(new MemoryService(f.storage),f.app.id,'产物偏好：简短说明 FLOW_MEMORY',{sourceMessageId:source.id});
  const next=h.submit('请使用产物偏好');assert.equal((await h.done(next)).state,'succeeded');assert.match(JSON.stringify(f.requests.at(-1).body),/FLOW_MEMORY/);
  t.diagnostic('Fixture model only: not M10 real-model or manual acceptance.');
});
test('production memory IPC is strict, durable across Host restart and rejects concurrent stale updates',async t=>{
  const f=await fixture(t),options={nodePath:runtime.node,entry:resolve('dist/service-host.cjs'),dataRoot:f.storage.paths.root};let manager=new ServiceManager(options);
  try {
    ok(await manager.start());
    const memory=ok(await manager.memories({operation:'save',appId:f.app.id,content:'IPC memory',type:'fact',expiresAt:null,priority:2,confirmed:true})).memory;
    const update={operation:'update',appId:f.app.id,memoryId:memory.id,expectedVersion:1,content:'IPC changed',type:'fact',expiresAt:null,priority:2,confirmed:true};
    const replies=await Promise.all([manager.memories(update),manager.memories(update)]);assert.equal(replies.filter(r=>r.ok).length,1);assert.equal(replies.find(r=>!r.ok).error.code,'VERSION_CONFLICT');
    assert.equal((await manager.memories({operation:'list',appId:f.app.id,path:'forged'})).error.code,'INVALID_INPUT');
    await manager.stop();manager=new ServiceManager(options);ok(await manager.start());
    const list=ok(await manager.memories({operation:'list',appId:f.app.id}));assert.equal(list.memories[0].version,2);assert.equal(list.memories[0].content,'IPC changed');
    ok(await manager.memories({operation:'delete',appId:f.app.id,memoryId:memory.id,expectedVersion:2}));assert.equal(ok(await manager.memories({operation:'list',appId:f.app.id})).total,0);
  } finally { await manager.stop(); }
});
