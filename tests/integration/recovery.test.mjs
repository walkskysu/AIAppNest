import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceManager } from '../../dist/service-manager.cjs';
import { fixture, runtime, ok, until, RunScheduler, Recovery, DiagnosticLog, diagnostics, activeTimeout, DomainError, RunFeed } from './fixtures/engine-harness.mjs';

const scope=(f,run)=>({ appId:f.app.id,conversationId:run?.conversationId ?? f.conversation.id,...(run ? { runId:run.id }:{}) });
const input=(f,text='hello')=>({ operation:'submit',...scope(f),revisionId:f.conversation.revisionId,requestId:randomUUID(),text,attachmentIds:[] });
const setup=(f,options={})=>{ const s=new RunScheduler(f.services,runtime,options);f.schedulers.push(s);return s; };
const get=(f,run)=>f.storage.runs.get({ appId:f.app.id,id:run.id });
const done=async(f,run)=>{ await until(()=>get(f,run).endedAt!==null);return get(f,run); };
const alive=pid=>{ try { process.kill(pid,0);return true; } catch { return false; } };
function legacyRun(f,state='running') {
  const run=f.storage.createRun({ id:randomUUID(),...scope(f),requestId:randomUUID(),state:'queued',phase:'created',version:1,
    createdAt:Date.now(),startedAt:null,endedAt:null,error:null,usage:null });
  if(state==='queued') return run;
  f.storage.transitionRun(run.appId,run.id,1,'starting');
  return f.storage.transitionRun(run.appId,run.id,2,'running');
}
function session(f,run) {
  const folder=f.storage.paths.conversation(run.appId,run.conversationId,'sessions');mkdirSync(folder,{ recursive:true });
  const file=join(folder,'fixture.jsonl');
  writeFileSync(file,JSON.stringify({ type:'session',version:3,id:randomUUID() })+'\n');
  f.storage.attachSessionFile(run.appId,run.conversationId,file);
  return file;
}

test('X01/X02 replay/live overlap deduplicates; expired cursor returns snapshot repair, listeners bounded',async t=>{
  const f=await fixture(t),s=setup(f),run=legacyRun(f);
  for(let i=0;i<300;i++) f.storage.appendEvent(run.appId,run.id,'engine.assistant.delta',{ text:String(i) });
  const feed=new RunFeed(run.id);
  let reply=ok(s.request({ operation:'subscribe',...scope(f,run),afterSeq:0 }));
  feed.merge(reply.events);feed.merge(reply.events);
  f.storage.appendEvent(run.appId,run.id,'engine.assistant.delta',{ text:'live' });
  while(feed.seq<301) { reply=ok(s.request({ operation:'next',subscriptionId:reply.subscriptionId,afterSeq:feed.seq }));feed.merge(reply.events); }
  assert.equal(feed.seq,301);assert.equal(feed.text.endsWith('live'),true);
  const future=ok(s.request({ operation:'next',subscriptionId:reply.subscriptionId,afterSeq:999 }));
  assert.equal(future.resetRequired,true);assert.equal(future.snapshotSeq,301);
  // Test-only corruption injection: production events remain immutable.
  f.storage.db.exec('DROP TRIGGER run_events_immutable_delete');
  f.storage.db.prepare('DELETE FROM run_events WHERE runId=? AND seq=2').run(run.id);
  const gap=ok(s.request({ operation:'next',subscriptionId:reply.subscriptionId,afterSeq:1 }));assert.equal(gap.resetRequired,true);
  feed.reset(gap.snapshotSeq);assert.equal(feed.text,'');
  ok(s.request({ operation:'unsubscribe',subscriptionId:reply.subscriptionId }));
  for(let i=0;i<150;i++) { const sub=ok(s.request({ operation:'subscribe',...scope(f,run),afterSeq:301 }));ok(s.request({ operation:'unsubscribe',subscriptionId:sub.subscriptionId })); }
  assert.equal(s.subscriptions.size,0);assert.equal(f.requests.length,0);
  // This run was deliberately inserted after scheduler initialization; no active worker owns it.
  f.storage.transitionRun(run.appId,run.id,3,'interrupted');
});

test('X04 startup freezes legacy runs, never trusts PID/stop text alone; queued work cancels with explicit retry path',async t=>{
  const f=await fixture(t),run=legacyRun(f),file=session(f,run),recovery=new Recovery(f.storage);
  const wrapped='user original\n<reference-memory>SENSITIVE_MEMORY</reference-memory>';
  f.storage.messages.insert({ id:randomUUID(),...scope(f),runId:run.id,role:'user',content:'user original',status:'complete',createdAt:Date.now() });
  recovery.beforePrompt(run,wrapped);
  appendFileSync(file,[{ type:'message',id:'user',parentId:null,message:{ role:'user',content:wrapped } },
    { type:'message',id:'answer',parentId:'user',message:{ role:'assistant',content:[{ type:'text',text:'confirmed engine content' }],stopReason:'stop' } }].map(x=>JSON.stringify(x)+'\n').join(''));
  f.storage.appendEvent(run.appId,run.id,'worker.identity',{ ownerPid:process.pid,ownerCreated:'WRONG_GENERATION' });
  const queued=legacyRun(f,'queued');
  const before=readFileSync(file);setup(f);
  assert.equal(get(f,run).state,'interrupted');assert.equal(get(f,queued).state,'cancelled');
  assert.equal(get(f,queued).error,'RECOVERY_QUEUE_CANCELLED');assert.equal(alive(process.pid),true);
  assert.deepEqual(readFileSync(file),before);assert.equal(f.requests.length,0);
  const messages=f.storage.messages.list(scope(f));assert.equal(messages.filter(m=>m.role==='user').length,1);
  assert.ok(!JSON.stringify(messages).includes('SENSITIVE_MEMORY'));
});

test('X04/X05 barrier completion evidence repairs success; repeated repairs have stable IDs and preserve tool ownership',async t=>{
  const f=await fixture(t),run=legacyRun(f),file=session(f,run),recovery=new Recovery(f.storage);
  recovery.beforePrompt(run,'task');
  const rows=[{ type:'message',id:'u',parentId:null,message:{ role:'user',content:'task' } },
    { type:'message',id:'a',parentId:'u',message:{ role:'assistant',stopReason:'toolUse',content:[{ type:'toolCall',id:'call',name:'write',arguments:{} }] } },
    { type:'message',id:'t',parentId:'a',message:{ role:'toolResult',toolCallId:'call',content:[{ type:'text',text:'tool result' }] } },
    { type:'message',id:'b',parentId:'t',message:{ role:'assistant',stopReason:'stop',content:[{ type:'text',text:'final' }] } }];
  appendFileSync(file,rows.map(x=>JSON.stringify(x)+'\n').join(''));
  recovery.witness(run,'succeeded',{ inputTokens:2,outputTokens:3 });
  const before=readFileSync(file),s=setup(f);assert.equal(get(f,run).state,'succeeded');
  const first=f.storage.messages.list(scope(f));assert.equal(first.length,2);
  for(let i=0;i<3;i++) assert.equal(ok(s.request({ operation:'repair',...scope(f,run) })).inserted,0);
  assert.deepEqual(f.storage.messages.list(scope(f)),first);assert.deepEqual(readFileSync(file),before);
  assert.deepEqual(get(f,run).usage,{ inputTokens:2,outputTokens:3 });
});

test('X05/X06 actual Pi session rebuilds deleted messages without duplicate prompt; malformed/versioned files remain unchanged',async t=>{
  const f=await fixture(t),s=setup(f),run=ok(s.request(input(f,'original'))).run;
  assert.equal((await done(f,run)).state,'succeeded');
  const file=f.storage.conversations.get({ appId:run.appId,id:run.conversationId }).piSessionFile,original=readFileSync(file);
  const assistant=f.storage.messages.list(scope(f)).find(m=>m.role==='assistant');assert.ok(assistant);
  f.storage.db.prepare("DELETE FROM messages WHERE runId=? AND role='assistant'").run(run.id);
  assert.equal(ok(s.request({ operation:'repair',...scope(f,run) })).inserted,1);
  assert.equal(f.storage.messages.get({ appId:run.appId,id:assistant.id }).content,assistant.content);
  assert.equal(ok(s.request({ operation:'repair',...scope(f,run) })).inserted,0);
  assert.equal(f.requests.length,1);assert.deepEqual(readFileSync(file),original);
  await s.close();
  for(const corrupt of [Buffer.concat([original,Buffer.from('{truncated')]),Buffer.from(original.toString().replace('"version":3','"version":999'))]) {
    writeFileSync(file,corrupt);
    assert.equal(ok(s.request({ operation:'repair',...scope(f,run) })).status,'session_invalid');
    assert.deepEqual(readFileSync(file),corrupt);
  }
});

test('X03/X04 actual Windows Worker and Service Host termination release ownership without replay', { timeout:30000 },async t=>{
  const f=await fixture(t),manager=new ServiceManager({ nodePath:runtime.node,entry:resolve('dist/service-host.cjs'),dataRoot:f.storage.paths.root });
  const unrelated=spawn(runtime.node,['-e','setInterval(()=>{},1000)'],{ windowsHide:true,stdio:'ignore' });
  try {
    ok(await manager.start());
    const baseline=ok(await manager.runs(input(f,'baseline'))).run;assert.equal((await done(f,baseline)).state,'succeeded');
    const first=ok(await manager.runs(input(f,'slow'))).run;await until(()=>f.requests.length===2);
    const identity=f.storage.latestEvent(first.appId,first.id,'worker.identity').payload;
    process.kill(identity.workerHostPid);await done(f,first);assert.equal(get(f,first).state,'interrupted');
    const second=ok(await manager.runs(input(f,'slow'))).run;await until(()=>f.requests.length===3);
    const queued=ok(await manager.runs(input(f,'queued'))).run;
    const owner=f.storage.latestEvent(second.appId,second.id,'worker.identity').payload;
    process.kill(manager.snapshot().pid);await until(()=>manager.snapshot().phase==='failed' && !manager.child);
    await until(()=>!alive(owner.workerHostPid));ok(await manager.start());
    assert.equal(get(f,second).state,'interrupted');assert.equal(get(f,queued).state,'cancelled');
    await delay(100);assert.equal(f.requests.length,3);assert.equal(alive(unrelated.pid),true);
    const retry=ok(await manager.runs({ ...input(f,'explicit retry'),retryOf:second.id })).run;
    assert.notEqual(retry.id,second.id);assert.equal((await done(f,retry)).state,'succeeded');
    assert.equal(f.storage.eventsAfter(retry.appId,retry.id,0)[0].payload.retryOf,second.id);
  } finally { unrelated.kill();await manager.stop(); }
});

test('X03 Windows Job rejects a reused PID with wrong creation identity before starting a child',async()=>{
  const result=spawn(runtime.nativeHost,['job',String(process.pid),'1',runtime.node,'-e','console.log("UNEXPECTED_CHILD")'],{ windowsHide:true });
  let output='';result.stdout.on('data',d=>output+=d);result.stderr.resume();
  const exit=await new Promise(resolve=>result.once('close',resolve));assert.equal(exit,127);assert.equal(output,'');
  assert.match(execFileSync(runtime.nativeHost,['identity',String(process.pid)],{ windowsHide:true,encoding:'utf8' }).trim(),/^\d+$/);
});

test('X07 simulated wake excludes suspended time from deadlines; resumes waiting without a retry',t=>{
  t.mock.timers.enable({ apis:['Date','setInterval'],now:1000 });
  let expired=0,wakes=0;activeTimeout(()=>expired++,2000,()=>wakes++);
  t.mock.timers.setTime(121000);t.mock.timers.tick(1000);
  assert.equal(wakes,1);assert.equal(expired,0);
  t.mock.timers.tick(2000);assert.equal(expired,1);assert.equal(wakes,1);
});

test('X08 large output feed caps text/tools while maintaining cursor, actual Pi final projection is bounded',async t=>{
  const runId=randomUUID(),feed=new RunFeed(runId);
  feed.merge(Array.from({ length:500 },(_,i)=>({ runId,seq:i+1,type:'engine.assistant.delta',payload:{ text:'x'.repeat(4096) } })));
  feed.merge(Array.from({ length:500 },(_,i)=>({ runId,seq:i+501,type:'engine.tool.result',payload:{ callId:String(i),name:'tool',result:'x'.repeat(20000) } })));
  assert.equal(feed.seq,1000);assert.equal(feed.text.length,65536);assert.equal(feed.tools.size,128);assert.equal(feed.truncated,true);
  const f=await fixture(t),s=setup(f),run=ok(s.request(input(f,'large'))).run;
  assert.equal((await done(f,run)).state,'succeeded');
  const messages=f.storage.messages.list(scope(f));assert.ok(messages.every(m=>m.content.length<66000));
  assert.ok(messages.some(m=>m.content.includes('展示截断')));
  const sessionFile=f.storage.conversations.get({ appId:run.appId,id:run.conversationId }).piSessionFile;
  assert.ok(statSync(sessionFile).size>100000);
});

test('X09 durable completion failure closes active workers, blocks admission and reports unsaved, never succeeded',async t=>{
  const f=await fixture(t),s=setup(f),append=f.storage.appendEvent.bind(f.storage);
  f.storage.appendEvent=(a,r,type,p,...rest)=>{ if(type==='run.completed') throw new DomainError('STORAGE_UNAVAILABLE');return append(a,r,type,p,...rest); };
  const run=ok(s.request(input(f))).run;await until(()=>s.failed);await until(()=>s.active.size===0);
  assert.notEqual(get(f,run).state,'succeeded');
  assert.equal(f.storage.messages.list(scope(f)).filter(m=>m.role==='assistant').length,0,'completion projection rolled back');
  assert.equal(ok(s.request({ operation:'get',...scope(f,run) })).storage,'unsaved');
  assert.equal(s.request(input(f,'must not start')).error.code,'STORAGE_UNAVAILABLE');
  f.storage.appendEvent=append;await s.close();
  const recovered=setup(f);assert.equal(get(f,run).state,'succeeded','durable idle witness and unchanged session allow later reconciliation');
  assert.equal(f.requests.length,1);assert.equal(ok(recovered.request({ operation:'repair',...scope(f,run) })).inserted,0);
});

test('X09 real SQLite page quota rejects unrecordable admission (not a physical-volume ENOSPC test)',async t=>{
  const f=await fixture(t),s=setup(f);
  const pages=f.storage.db.prepare('PRAGMA page_count').get().page_count;
  f.storage.db.exec(`PRAGMA max_page_count=${pages}`);
  const result=s.request(input(f,'x'.repeat(512*1024)));
  assert.equal(result.ok,false);assert.equal(result.error.code,'STORAGE_UNAVAILABLE');
  assert.equal(f.storage.chatHistory(f.app.id,f.conversation.id,100,0).runs.length,0);assert.equal(f.requests.length,0);
  assert.equal(s.failed,true);
});

test('X10/X11 diagnostics are allowlisted, no prompt/memory/credential/tool payload; logs rotate and expire; cost unknown',async t=>{
  const f=await fixture(t),run=legacyRun(f),secret='sk-TEST_SECRET_sensitive_marker';
  f.storage.appendEvent(run.appId,run.id,'engine.error',{ code:secret,exitCode:12,prompt:secret,memory:secret });
  f.storage.appendEvent(run.appId,run.id,'engine.tool.result',{ result:secret });
  f.storage.appendEvent(run.appId,run.id,'policy.waiting',{ target:secret });
  f.storage.appendEvent(run.appId,run.id,'recovery.result',{ action:secret });
  f.storage.transitionRun(run.appId,run.id,3,'interrupted',Date.now(),secret);
  const d=diagnostics(f.storage,get(f,run));assert.equal(d.cost,'unknown');assert.equal(d.usage,null);assert.equal(d.exitCode,12);assert.equal(d.errorCategory,'UNKNOWN');
  assert.ok(!JSON.stringify(d).includes(secret));
  const log=new DiagnosticLog(f.storage,1024,1000);for(let i=0;i<20;i++) log.write(get(f,run));
  const folder=join(f.storage.paths.root,'logs'),files=readdirSync(folder);assert.ok(files.length<=3);assert.ok(files.length>=2);
  for(const file of files) { assert.ok(statSync(join(folder,file)).size<=1024);assert.ok(!readFileSync(join(folder,file),'utf8').includes(secret));utimesSync(join(folder,file),new Date(0),new Date(0)); }
  new DiagnosticLog(f.storage,1024,1000);assert.equal(readdirSync(folder).length,0);
});
