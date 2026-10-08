import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpus,totalmem,platform,release,arch } from 'node:os';
import { writeFileSync } from 'node:fs';
import { fixture,Storage,MemoryService,ok } from './fixtures/engine-harness.mjs';

test('H10 reproducible 10,000-memory search and injection benchmark (fixture data, real SQLite)',async t=>{
  const f=await fixture(t),now=Date.now(),templates=['回答偏好：使用简短中文说明 Windows 设置','项目约定：飞书多维表格跟踪需求','开发环境：VS Code 与 TypeScript','数据库术语：PostgreSQL 连接池'];
  f.storage.transaction(()=>{for(let i=0;i<10000;i++)f.storage.memories.insert({id:randomUUID(),appId:f.app.id,version:1,type:'fact',content:`${templates[i%4]}；编号 ${i}；索引性能样本`,
    status:'active',confidence:null,sourceConversationId:null,sourceRunId:null,sourceMessageId:null,priority:i%10,expiresAt:null,createdAt:now,updatedAt:now});});
  const queries=['简短中文','飞书多维表格','TypeScript','PostgreSQL','索引性能样本','编号9999','不存在的内容'];
  const samples={warmSearch:[],reopenedSearch:[],warmInjection:[],reopenedInjection:[]};
  const measure=(storage,query,inject)=>{
    const service=new MemoryService(storage);
    let run;
    if(inject){const c=storage.createConversation(f.app.id,randomUUID(),'benchmark');const queued=storage.createRun({id:randomUUID(),appId:f.app.id,conversationId:c.id,requestId:randomUUID(),state:'queued',phase:'created',version:1,createdAt:Date.now(),startedAt:null,endedAt:null,error:null,usage:null});run=storage.transitionRun(f.app.id,queued.id,1,'starting');}
    const start=performance.now();
    if(inject){const text=service.inject(run,query,{enabled:true,maxItems:8,tokenBudget:1500},1500);assert.ok(Buffer.byteLength(text)<=1500);}
    else ok(service.request({operation:'search',appId:f.app.id,query,kind:'memory',mode:'phrase',limit:20,offset:0}));
    const elapsed=performance.now()-start;
    if(run)storage.transitionRun(f.app.id,run.id,2,'interrupted');
    return elapsed;
  };
  for(const q of queries){measure(f.storage,q,false);measure(f.storage,q,true);}
  for(let i=0;i<70;i++){const q=queries[i%queries.length];samples.warmSearch.push(measure(f.storage,q,false));samples.warmInjection.push(measure(f.storage,q,true));}
  for(let i=0;i<21;i++){const q=queries[i%queries.length];let db=new Storage(f.storage.paths.root);try{samples.reopenedSearch.push(measure(db,q,false));}finally{db.close();}
    db=new Storage(f.storage.paths.root);try{samples.reopenedInjection.push(measure(db,q,true));}finally{db.close();}}
  const summary=Object.fromEntries(Object.entries(samples).map(([name,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [name,{count:values.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)}];}));
  const report={issue:18,date:new Date().toISOString(),data:'10,000 active memories in one application, four templates plus unique numeric suffix; synthetic fixture',
    hardware:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryGiB:Math.round(totalmem()/1024**3),platform:platform(),release:release(),arch:arch(),node:process.version},
    cache:'Warm: same connection after one sweep. Reopened: fresh SQLite connection; OS filesystem cache NOT flushed. True cold physical-disk measurement pending.',
    timing:'Full synchronous MemoryService search/inject call. Injection includes transaction, selection, budget checks and audit commit; run setup excluded.',
    queries,summary,samples,targetMs:300,automatedTargetMet:Object.values(summary).every(x=>x.p95Ms<300),manualAcceptance:'pending'};
  if(process.env.AIAPPNEST_RECORD_MEMORY_BENCHMARK==='1')writeFileSync('docs/technical/evidence/memory-candidates-benchmark.json',JSON.stringify(report,null,2)+'\n');
  t.diagnostic(JSON.stringify({summary,targetMet:report.automatedTargetMet}));
  assert.equal(f.storage.activeMemories(f.app.id).length,10000);
});
