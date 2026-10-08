import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fixture,ok,MemoryService,Storage } from './fixtures/engine-harness.mjs';
const dataset=JSON.parse(readFileSync(new URL('../fixtures/chinese-search.json',import.meta.url),'utf8'));
const call=(f,input)=>new MemoryService(f.storage).request({appId:f.app.id,...input});
const save=(f,content,extra={})=>ok(call(f,{operation:'save',type:'fact',content,priority:0,expiresAt:null,confirmed:true,...extra})).memory;
const search=(f,query,extra={})=>ok(call(f,{operation:'search',query,kind:'memory',...extra}));

test('H06 recorded Chinese phrase/proper noun/mixed/negation/duplicate/typo dataset; memory and conversation search',async t=>{
  const f=await fixture(t),ids=new Map(),messages=new Map();
  for(const row of dataset.records){ids.set(save(f,row.content).id,row.id);const message=f.storage.messages.insert({id:randomUUID(),appId:f.app.id,conversationId:f.conversation.id,runId:null,role:'user',status:'complete',content:row.content,createdAt:Date.now()});messages.set(message.id,row.id);}
  for(const q of dataset.queries)for(const kind of ['memory','message']){
    const result=search(f,q.text,{mode:q.mode,kind});const map=kind==='memory'?ids:messages;
    assert.deepEqual(result.hits.map(h=>map.get(h.id)).sort(),[...q.expected].sort(),`${kind} ${q.mode} ${q.text}`);assert.equal(result.total,q.expected.length);
    if(result.hits.length)assert.ok(result.hits.every(h=>h.snippet.length>0));
  }
  t.diagnostic(`Dataset v${dataset.version}: ${dataset.queries.length} queries × 2 corpora, exact expected-set comparisons. Does not certify general semantic recall.`);
});

test('H07/H08 binding, stable pagination, app-isolated totals/snippets and timely edit/disable/delete/expiry/source archive filtering',async t=>{
  const f=await fixture(t);const a=save(f,'上海虹桥 APP_A_ONLY'),b=save(f,'上海虹桥 APP_A_TWO'),c=save(f,'上海虹桥 APP_A_THREE');
  const first=search(f,'上海虹桥',{limit:1}),second=search(f,'上海虹桥',{limit:1,offset:1});assert.equal(first.total,3);assert.notEqual(first.hits[0].id,second.hits[0].id);assert.deepEqual(search(f,'上海虹桥',{limit:1}),first);
  const other=ok(f.apps.request({operation:'create',metadata:{...f.metadata,name:'isolated'}})).app;
  save(f,'上海虹桥 APP_B_SECRET',{appId:other.id});
  for(const mode of ['phrase','terms','fuzzy']){const result=search(f,'上海虹桥',{mode});assert.equal(result.total,3);assert.ok(!JSON.stringify(result).includes('APP_B_SECRET'));}
  for(const query of ['" OR *','上海虹桥" OR appId:*','\'); DROP TABLE memories;--','NEAR(上海 虹桥, 1)',''])assert.doesNotThrow(()=>search(f,query));
  const revised=ok(call(f,{operation:'update',memoryId:a.id,expectedVersion:1,content:'深圳宝安 UPDATED',type:'fact',priority:0,expiresAt:null,confirmed:true})).memory;
  ok(call(f,{operation:'disable',memoryId:b.id,expectedVersion:1}));ok(call(f,{operation:'delete',memoryId:c.id,expectedVersion:1}));
  save(f,'上海虹桥 EXPIRED',{expiresAt:Date.now()-1});assert.equal(search(f,'上海虹桥').total,0);assert.equal(search(f,'深圳宝安').hits[0].version,revised.version);
  const expires=save(f,'短暂有效状态',{expiresAt:Date.now()+80});assert.equal(search(f,'短暂有效状态').total,1);await new Promise(r=>setTimeout(r,90));assert.equal(search(f,'短暂有效状态').total,0);
  const message=f.storage.messages.insert({id:randomUUID(),appId:f.app.id,conversationId:f.conversation.id,runId:null,role:'assistant',content:'上海虹桥 MESSAGE',status:'streaming',createdAt:Date.now()});
  assert.equal(search(f,'上海虹桥',{kind:'message'}).total,0);f.storage.updateMessage(f.app.id,message.id,message.content,'complete');assert.equal(search(f,'上海虹桥',{kind:'message'}).total,1);
  f.storage.archiveConversation(f.app.id,f.conversation.id);assert.equal(search(f,'上海虹桥',{kind:'message'}).total,0);
  ok(call(f,{operation:'rebuild'}));assert.equal(search(f,'上海虹桥').total,0);assert.equal(search(f,'短暂有效状态').total,0);assert.equal(search(f,'上海虹桥',{kind:'message'}).total,0);
  assert.equal(f.storage.latestMemory(f.app.id,expires.id).content,'短暂有效状态');
});

test('H09 rebuild rollback retains complete prior index and sources; version mismatch fails closed until rebuilt',async t=>{
  const f=await fixture(t),memory=save(f,'可重建索引 数据原文');const before=search(f,'可重建索引');
  assert.throws(()=>f.storage.search.rebuild(()=>{throw new Error('simulated disk failure');}));assert.deepEqual(search(f,'可重建索引'),before);assert.equal(f.storage.latestMemory(f.app.id,memory.id).content,memory.content);
  const raw=new DatabaseSync(f.storage.paths.database);raw.prepare('UPDATE search_meta SET version=0').run();
  assert.equal(call(f,{operation:'search',query:'可重建索引',kind:'memory'}).error.code,'STORAGE_UNAVAILABLE');
  assert.throws(()=>f.storage.search.rebuild(()=>{throw new Error('failure while upgrading');}));assert.equal(raw.prepare('SELECT version FROM search_meta').get().version,0);
  raw.close();const reopened=new Storage(f.storage.paths.root);try{assert.equal(reopened.search.search(f.app.id,'可重建索引','memory','phrase',20,0).total,1);}finally{reopened.close();}
  assert.deepEqual(search(f,'可重建索引'),before);
});

test('H08 migration from manual-memory schema rebuilds only live latest versions',async t=>{
  const f=await fixture(t),active=save(f,'升级索引 活跃'),removed=save(f,'升级索引 删除');ok(call(f,{operation:'delete',memoryId:removed.id,expectedVersion:1}));
  // Version-0 derived data is the actual state immediately after migration 10; force a rebuild from authoritative rows.
  const raw=new DatabaseSync(f.storage.paths.database);raw.exec('UPDATE search_meta SET version=0');raw.close();
  const reopened=new Storage(f.storage.paths.root);try{const result=reopened.search.search(f.app.id,'升级索引','memory','phrase',20,0);assert.equal(result.total,1);assert.equal(result.hits[0].id,active.id);}finally{reopened.close();}
});
