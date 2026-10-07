import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceManager } from '../../dist/service-manager.cjs';
import { fixture, runtime, ok, until, ChatService, RunScheduler, RunFeed, safeExternal, shouldSubmit, Storage } from './fixtures/engine-harness.mjs';
const terminal = r => ['succeeded','failed','cancelled','interrupted','handled'].includes(r.state);
function setup(f, options = {}) {
  const scheduler = new RunScheduler(f.services,runtime,options); f.schedulers.push(scheduler);
  const chat = new ChatService(f.storage,f.apps,scheduler);
  const call = input => ok(chat.request({ appId:f.app.id,...input }));
  const done = async run => { await until(() => terminal(f.storage.runs.get({ appId:run.appId,id:run.id }))); return f.storage.runs.get({ appId:run.appId,id:run.id }); };
  return { scheduler,chat,call,done };
}
test('C01/C02 candidate trial is isolated, immutable, durable and publishes exact tested revision idempotently', { timeout:30000 },async t => {
  const f = await fixture(t), h = setup(f,{ memory:() => 'MUST_NOT_APPEAR_IN_TRIAL' });
  let app = ok(f.apps.request({ operation:'create',metadata:f.metadata })).app;
  app = ok(f.apps.request({ operation:'update',appId:app.id,expectedVersion:app.version,metadata:f.metadata,draft:f.app.draft })).app;
  const input = { operation:'trial.start',appId:app.id,expectedVersion:app.version,trialId:randomUUID(),text:'candidate original task' };
  const trial = h.call(input).trial;
  assert.equal(h.call(input).trial.run.id,trial.run.id);
  assert.equal(f.storage.apps.get({ id:app.id }).currentRevisionId,null);
  assert.equal(h.call({ operation:'list',appId:app.id,query:'',limit:20,offset:0 }).total,0);
  assert.equal((await h.done(trial.run)).state,'succeeded');
  assert.ok(!JSON.stringify(f.requests).includes('MUST_NOT_APPEAR_IN_TRIAL'));
  const tested = f.apps.readRevision(app.id,trial.revisionId);
  const publish = { operation:'trial.publish',appId:app.id,trialId:trial.id,expectedVersion:app.version };
  const activate = f.storage.activateTrial.bind(f.storage);
  f.storage.activateTrial = (...args) => { activate(...args); throw new Error('injected commit failure'); };
  assert.equal(h.chat.request(publish).ok,false);
  assert.equal(f.storage.apps.get({ id:app.id }).currentRevisionId,null);
  assert.equal(f.storage.appDraft(app.id).config.role,app.draft.role);
  f.storage.activateTrial = activate;
  const published = h.call(publish).app;
  assert.equal(published.currentRevisionId,trial.revisionId);
  assert.equal(h.call(publish).app.version,published.version);
  assert.equal(f.storage.revisions.list({ appId:app.id }).length,1);
  assert.equal(f.apps.readRevision(app.id,published.currentRevisionId).configHash,tested.configHash);
  const conversation = h.call({ operation:'create',appId:app.id,conversationId:randomUUID(),title:'正式会话' }).conversation;
  assert.notEqual(f.storage.paths.conversation(app.id,trial.conversationId,'sessions'),f.storage.paths.conversation(app.id,conversation.id,'sessions'));
  app = ok(f.apps.request({ operation:'update',appId:app.id,expectedVersion:published.version,metadata:f.metadata,draft:{ ...app.draft,role:'new role' } })).app;
  assert.equal(h.call({ operation:'trial.list',appId:app.id }).trials[0].stale,true);
  assert.equal(tested.snapshot.config.role,f.app.draft.role);
  const trial2 = h.call({ ...input,trialId:randomUUID(),expectedVersion:app.version,text:'slow' }).trial;
  app = ok(f.apps.request({ operation:'update',appId:app.id,expectedVersion:app.version,metadata:f.metadata,draft:{ ...app.draft,role:'changed while running' } })).app;
  assert.equal(h.chat.request({ ...publish,trialId:trial2.id,expectedVersion:app.version }).error.code,'VERSION_CONFLICT');
  assert.equal(f.apps.readRevision(app.id,trial2.revisionId).snapshot.config.role,'new role');
  await h.scheduler.close();
});
test('C03/C04/C10 scoped search, stable pagination, pinned versions and history survive storage reopen', async t => {
  const f = await fixture(t), h = setup(f);
  const a = h.call({ operation:'create',conversationId:randomUUID(),title:'中文查找' }).conversation;
  assert.equal(h.call({ operation:'create',conversationId:a.id,title:'ignored duplicate' }).conversation.id,a.id);
  const foreign = ok(f.apps.request({ operation:'copy',appId:f.app.id,expectedVersion:f.app.version })).app;
  for (const operation of ['history','rename','delete']) {
    const extra = operation === 'history' ? { limit:100,offset:0 } : operation === 'rename' ? { title:'foreign' } : { scope:'chat-and-attachments',preserveMemory:true,preserveArtifacts:true };
    assert.equal(h.chat.request({ operation,appId:foreign.id,conversationId:a.id,...extra }).error.code,'NOT_FOUND');
  }
  for (let i=0;i<205;i++) f.storage.messages.insert({ id:randomUUID(),appId:f.app.id,conversationId:a.id,runId:null,role:'user',content:`中文消息${i}`,status:'complete',createdAt:1 });
  const pages = [0,100,200].flatMap(offset => h.call({ operation:'history',conversationId:a.id,limit:100,offset }).messages);
  assert.equal(new Set(pages.map(m=>m.id)).size,205);
  assert.deepEqual(pages.map(m=>m.id),pages.map(m=>m.id).sort());
  assert.equal(h.call({ operation:'list',query:'中文消息',limit:20,offset:0 }).total,1);
  assert.equal(h.call({ operation:'list',appId:foreign.id,query:'中文消息',limit:20,offset:0 }).total,0);
  h.call({ operation:'rename',conversationId:a.id,title:'renamed' });
  const reopened = new Storage(f.storage.paths.root);
  try { assert.equal(reopened.chatHistory(f.app.id,a.id,100,200).messages.length,5); assert.equal(reopened.conversations.get({ appId:f.app.id,id:a.id }).revisionId,a.revisionId); }
  finally { reopened.close(); }
  assert.equal(f.requests.length,0);
});
test('C05/C08 deletion stops actual Pi before recycling and preserves memory/artifacts; retry association is scoped', { timeout:30000 },async t => {
  const f = await fixture(t), h = setup(f);
  const input = { operation:'submit',appId:f.app.id,conversationId:f.conversation.id,revisionId:f.conversation.revisionId,requestId:randomUUID(),text:'slow',attachmentIds:[] };
  const run = ok(h.scheduler.request(input)).run;
  assert.equal(ok(h.scheduler.request(input)).run.id,run.id);
  await until(() => f.requests.length === 1);
  const memory = { id:randomUUID(),appId:f.app.id,version:1,type:'fact',content:'keep me',status:'active',confidence:null,sourceConversationId:f.conversation.id,sourceRunId:run.id,sourceMessageId:null,createdAt:Date.now(),updatedAt:Date.now(),expiresAt:null };
  f.storage.memories.insert(memory);
  const artifactId = randomUUID();
  f.storage.artifacts.insert({ id:artifactId,appId:f.app.id,conversationId:f.conversation.id,runId:run.id,
    relativePath:f.storage.paths.artifact(f.app.id,f.conversation.id,artifactId),mimeType:'text/plain',size:0,hash:'a'.repeat(64),createdAt:Date.now() });
  const deletion = { operation:'delete',conversationId:f.conversation.id,scope:'chat-and-attachments',preserveMemory:true,preserveArtifacts:true };
  assert.equal(h.call(deletion).archived,false);
  assert.equal(h.scheduler.request({ ...input,requestId:randomUUID() }).ok,false);
  await h.done(run); await until(() => h.call(deletion).archived);
  assert.equal(f.storage.conversations.get({ appId:f.app.id,id:f.conversation.id }).status,'archived');
  assert.equal(f.storage.memories.get({ appId:f.app.id,id:memory.id,version:1 }).content,'keep me');
  assert.equal(f.storage.artifacts.get({ appId:f.app.id,id:artifactId }).runId,run.id);
  assert.equal(h.scheduler.workers.size,0);
  const second = h.call({ operation:'create',conversationId:randomUUID(),title:'retry' }).conversation;
  assert.equal(h.scheduler.request({ ...input,conversationId:second.id,requestId:randomUUID(),retryOf:run.id }).ok,false);
  const failed = ok(h.scheduler.request({ ...input,conversationId:second.id,requestId:randomUUID(),text:'model-error' })).run;
  await h.done(failed);
  const retried = ok(h.scheduler.request({ ...input,conversationId:second.id,requestId:randomUUID(),text:'retry succeeds',retryOf:failed.id })).run;
  assert.notEqual(retried.id,failed.id); assert.equal((await h.done(retried)).state,'succeeded');
  assert.equal(f.storage.eventsAfter(f.app.id,retried.id,0)[0].payload.retryOf,failed.id);
});
test('C07/C09/C10 event replay handles duplicates/gaps/foreign runs and input composition cannot submit', () => {
  const runId = randomUUID(), feed = new RunFeed(runId), event = seq => ({ runId,seq,type:'engine.assistant.delta',payload:{ text:String(seq) },createdAt:1 });
  feed.merge([event(2),event(1),event(2),{ ...event(3),runId:randomUUID() }]); assert.equal(feed.text,'12');
  feed.merge([event(4)]); assert.equal(feed.seq,2);
  feed.merge([event(4),event(3),event(2)]); assert.equal(feed.text,'1234');
  for (const raw of ['javascript:alert(1)','data:text/html,<script>','file:///C:/secret','https://user:password@example.com']) assert.equal(safeExternal(raw),null);
  assert.equal(safeExternal('https://example.com/path'),'https://example.com/path');
  const enter = { key:'Enter',shiftKey:false,isComposing:false,keyCode:13 };
  assert.equal(shouldSubmit(enter,false),true);
  for (const input of [{ ...enter,isComposing:true },{ ...enter,keyCode:229 },{ ...enter,shiftKey:true }]) assert.equal(shouldSubmit(input,false),false);
  assert.equal(shouldSubmit(enter,true),false);
});

test('C01/C04/C05/C09 production chat IPC trial/publish/history with real Pi and exact session restore, no automatic replay', { timeout:30000 },async t => {
  const f = await fixture(t);
  const options = { nodePath:runtime.node,entry:resolve('dist/service-host.cjs'),dataRoot:f.storage.paths.root };
  let manager = new ServiceManager(options);
  const chat = async input => ok(await manager.chat({ appId:f.app.id,...input }));
  const done = async run => { for(let i=0;i<500;i++) { const current=ok(await manager.runs({ operation:'get',appId:run.appId,conversationId:run.conversationId,runId:run.id })).run; if(terminal(current)) return current; await delay(20); } throw Error('timeout'); };
  try {
    ok(await manager.start());
    assert.equal((await manager.chat({ operation:'history',appId:f.app.id,conversationId:f.conversation.id,limit:100,offset:0,path:'forged' })).ok,false);
    const trial = (await chat({ operation:'trial.start',expectedVersion:f.app.version,trialId:randomUUID(),text:'IPC trial' })).trial;
    assert.equal((await done(trial.run)).state,'succeeded');
    const published = await chat({ operation:'trial.publish',expectedVersion:f.app.version,trialId:trial.id });
    const conversation = (await chat({ operation:'create',conversationId:randomUUID(),title:'durable' })).conversation;
    assert.equal(conversation.revisionId,published.app.currentRevisionId);
    const input = { operation:'submit',appId:f.app.id,conversationId:conversation.id,revisionId:conversation.revisionId,requestId:randomUUID(),text:'IPC remembered marker',attachmentIds:[] };
    const receipts = await Promise.all([manager.runs(input),manager.runs(input)]);
    assert.equal(ok(receipts[0]).run.id,ok(receipts[1]).run.id);
    assert.equal((await done(ok(receipts[0]).run)).state,'succeeded');
    const file = f.storage.conversations.get({ appId:f.app.id,id:conversation.id }).piSessionFile;
    await manager.stop(); manager = new ServiceManager(options); ok(await manager.start());
    const before = f.requests.length;
    const history = await chat({ operation:'history',conversationId:conversation.id,limit:100,offset:0 });
    assert.equal(history.messages.length,2); assert.equal(f.requests.length,before);
    assert.equal((await done(ok(await manager.runs({ ...input,requestId:randomUUID(),text:'recall' })).run)).state,'succeeded');
    assert.equal(f.storage.conversations.get({ appId:f.app.id,id:conversation.id }).piSessionFile,file);
    const next = await chat({ operation:'history',conversationId:conversation.id,limit:100,offset:0 });
    assert.match(next.messages.at(-1).content,/IPC remembered marker/);
    const foreign = await manager.chat({ operation:'history',appId:randomUUID(),conversationId:conversation.id,limit:100,offset:0 });
    assert.equal(foreign.ok,false);
  } finally { await manager.stop(); }
});
