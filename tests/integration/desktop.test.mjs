import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, rm, rename, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(40); } throw new Error('Condition timed out'); }
function environment() { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; return env; }
async function launch(t, root = resolve('dist')) {
  const profile = await mkdtemp(resolve('.test-profile-'));
  // Register cleanup before launch as native sandbox initialization can fail.
  let app;
  let closed = false;
  t.after(async () => {
    if (app && !closed) await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  app = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], env: environment(), timeout: 20000 });
  app.on('close', () => { closed = true; });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.desktop);
  return { app, page, profile };
}
async function ready(page) { await page.waitForFunction(() => document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase') === 'ready'); }

test('Data UI selects directories through Main, verifies backup, stages restore and exposes credential rebinding', {timeout:90000}, async t=>{
  const parent=await mkdtemp(resolve('.test-data-ui-'));
  t.after(()=>rm(parent,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const {app,page}=await launch(t);await ready(page);
  const panel=page.getByTestId('data-settings');await panel.waitFor();
  assert.match(await panel.textContent(),/旧备份仍保留/);
  // Only the native picker result is substituted; Main still issues owner-bound tokens.
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},parent);
  await panel.getByRole('button',{name:'创建一致性备份',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="data-settings"] [role="status"]')?.textContent.includes('succeeded'));
  const listing=await page.evaluate(()=>window.desktop.data({operation:'recycle.list'}));assert.equal(listing.ok,true);
  const backup=listing.value.jobs.find(j=>j.kind==='backup');assert.equal(backup.state,'succeeded');
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},backup.output);
  await panel.getByRole('button',{name:'选择备份并校验',exact:true}).click();
  await panel.getByText('备份完整性及兼容性校验通过，可恢复到新目录。',{exact:true}).waitFor();
  await app.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]});},parent);
  await panel.getByRole('button',{name:'恢复到新目录',exact:true}).click();
  await panel.getByRole('button',{name:'停止服务、切换并重启',exact:true}).waitFor();
  await panel.getByRole('button',{name:'打开凭据重绑设置',exact:true}).click();
  await page.getByRole('button',{name:'关闭模型设置',exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.desktop.data({operation:'backups.create',path:'C:/arbitrary'}))).ok,false);
});

test('C01-C10 desktop wizard/chat uses production IPC + Pi with deterministic SSE; never claims live-model acceptance', { timeout:90000 }, async t => {
  const requests = [];
  const malicious = '<img src="https://invalid.example/track" onerror="window.PWNED=1"><script>window.PWNED=1</script> [bad](javascript:alert(1))';
  const server = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const last = body.messages.at(-1), text = typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('');
    if (text === 'slow') return;
    const answer = text === 'attack' ? malicious : `回复：${text}`;
    res.writeHead(200,{ 'content-type':'text/event-stream' });
    const send = (delta,finish_reason=null) => res.write('data: '+JSON.stringify({ id:'chat-fixture',object:'chat.completion.chunk',created:1,model:'chat-fixture',choices:[{ index:0,delta,finish_reason }] })+'\n\n');
    send({ role:'assistant',content:answer.slice(0,3) });
    setTimeout(() => { send({ content:answer.slice(3) }); send({},'stop'); res.end('data: [DONE]\n\n'); },80);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { app,page,profile } = await launch(t); await ready(page);
  await page.getByRole('button',{ name:'创建应用',exact:true }).click();
  await page.getByLabel('应用名称',{ exact:true }).fill('完整创建聊天');
  await page.getByLabel('角色说明',{ exact:true }).fill('中文助手');
  await page.getByLabel('开场白',{ exact:true }).fill('欢迎开始');
  await page.getByRole('button',{ name:'配置模型和凭据',exact:true }).click();
  await page.getByLabel('显示名称',{ exact:true }).fill('聊天夹具');
  await page.getByLabel('协议',{ exact:true }).selectOption('local-openai');
  await page.getByLabel('端点',{ exact:true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('模型 ID',{ exact:true }).fill('chat-fixture');
  await page.getByRole('button',{ name:'保存模型',exact:true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText:'已保存' }).waitFor();
  await page.getByRole('button',{ name:'刷新模型选项',exact:true }).click();
  await page.getByLabel('应用模型',{ exact:true }).selectOption({ label:'聊天夹具 · chat-fixture · v1' });
  await page.getByRole('button',{ name:'测试所选模型连接',exact:true }).click();
  await page.getByTestId('app-feedback').filter({ hasText:'SUCCESS' }).waitFor();
  await page.getByRole('button',{ name:'保存应用草稿',exact:true }).click();
  await page.getByTestId('app-feedback').filter({ hasText:'草稿已保存' }).waitFor();
  await page.getByLabel('测试任务',{ exact:true }).fill('测试创建');
  await page.getByRole('button',{ name:'提交隔离试运行',exact:true }).click();
  await page.getByTestId('app-space').getByText('已完成',{ exact:true }).waitFor();
  await page.getByRole('button',{ name:'刷新试运行结果',exact:true }).click();
  await page.getByLabel('输出要求',{ exact:true }).fill('修改后测试失效');
  assert.equal(await page.getByRole('button',{ name:'发布配置版本',exact:true }).isDisabled(),true);
  await page.getByLabel('输出要求',{ exact:true }).fill('');
  await page.getByRole('button',{ name:'保存应用草稿',exact:true }).click();
  await page.getByRole('button',{ name:'发布配置版本',exact:true }).click();
  await page.getByTestId('app-feedback').filter({ hasText:'已发布测试过' }).waitFor();
  await page.getByRole('button',{ name:'关闭编辑',exact:true }).click();
  const before = requests.length;
  await page.getByTestId('app-card').getByRole('button',{ name:'打开应用',exact:true }).click();
  await page.getByRole('button',{ name:'新建对话',exact:true }).click();
  await page.getByText('欢迎开始',{ exact:true }).waitFor(); assert.equal(requests.length,before);
  const input = page.getByLabel('输入任务',{ exact:true });
  await input.fill('中文提交');
  await input.dispatchEvent('compositionstart'); await input.press('Enter'); await wait(100); assert.equal(requests.length,before);
  await input.dispatchEvent('compositionend');
  await page.getByRole('button',{ name:'发送',exact:true }).dblclick();
  await page.getByText('回复：中文提交',{ exact:true }).waitFor(); assert.equal(requests.length,before+1);
  await input.fill('attack'); await input.press('Enter');
  await page.getByText(malicious,{ exact:true }).waitFor();
  assert.equal(await page.evaluate(() => window.PWNED),undefined);
  assert.equal(await page.locator('.chat-history img,.chat-history script,.chat-history iframe').count(),0);
  assert.equal((await page.evaluate(() => window.desktop.openExternal('javascript:alert(1)'))).ok,false);
  const beforeRefresh = requests.length;
  await page.reload(); await ready(page);
  await page.getByTestId('app-card').getByRole('button',{ name:'打开应用',exact:true }).click();
  await page.getByRole('button',{ name:'新对话',exact:true }).click();
  await page.getByText(malicious,{ exact:true }).waitFor(); await wait(200); assert.equal(requests.length,beforeRefresh);
  // X01/X02/X04: a live view reconnects after Host replacement without sending another prompt.
  await input.fill('slow');await input.press('Enter');await page.getByText('正在执行',{ exact:true }).waitFor();
  await until(()=>requests.length===beforeRefresh+1);
  const servicePid=(await page.evaluate(()=>window.desktop.getStatus())).value.pid;
  process.kill(servicePid);
  await page.waitForFunction(()=>document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase')==='failed');
  await page.getByRole('button',{ name:'重试服务',exact:true }).click();await ready(page);
  await page.getByText('执行中断',{ exact:true }).waitFor();await wait(200);assert.equal(requests.length,beforeRefresh+1);
  await page.getByText('运行诊断',{ exact:true }).last().click();
  await page.getByRole('button',{ name:'读取脱敏诊断',exact:true }).last().click();
  const diagnostic=await page.getByLabel('脱敏诊断导出（可复制保存）').inputValue();
  assert.equal(JSON.parse(diagnostic).cost,'unknown');assert.ok(!diagnostic.includes('slow'));
  const exported=join(profile,'recovery-diagnostic.json');
  await app.evaluate(({ dialog },file)=>{ dialog.showSaveDialog=async()=>({ canceled:false,filePath:file }); },exported);
  await page.getByRole('button',{ name:'导出脱敏诊断',exact:true }).last().click();
  await page.getByTestId('chat-feedback').filter({ hasText:'脱敏诊断已保存' }).waitFor();
  assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(exported,'utf8')).cost,'unknown');
  await input.fill('slow'); await input.press('Enter');
  await page.getByText('正在执行',{ exact:true }).waitFor();
  await page.getByRole('button',{ name:'删除会话',exact:true }).click();
  await page.getByRole('button',{ name:'确认移入回收区',exact:true }).click();
  await page.getByText('已停止',{ exact:true }).waitFor();
  await page.getByRole('button',{ name:'确认移入回收区',exact:true }).click();
  await page.getByTestId('chat-feedback').filter({ hasText:'已移入回收区' }).waitFor();
  await page.screenshot({ path:join(profile,'chat-verified.png'),fullPage:true });
  t.diagnostic('Deterministic SSE fixture; real Electron, preload, Service Host, SQLite, Pi and Windows Worker. Not C01 live acceptance; manual visual review remains separate.');
});

test('Memory UI: confirmed save, source jump, type filter, version history, disable/delete and new-session injection', { timeout:90000 },async t => {
  const requests=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req) raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:'确定性记忆测试回复'},null],[{},'stop']]) res.write('data: '+JSON.stringify({id:'memory-ui',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const {page}=await launch(t);await ready(page);
  await page.evaluate(async endpoint=>{
    const ok=r=>{if(!r.ok) throw Error(r.error.message);return r.value;};
    const model=ok(await window.desktop.providers({operation:'save',input:{config:{name:'Memory fixture',providerType:'local-openai',endpoint,modelId:'fixture',authMode:'none',settings:{timeoutMs:10000}},credential:{action:'clear'}}})).profile;
    const metadata={name:'记忆界面测试',description:'',icon:'book',category:'',favorite:false};
    let app=ok(await window.desktop.apps({operation:'create',metadata})).app;
    app=ok(await window.desktop.apps({operation:'update',appId:app.id,expectedVersion:app.version,metadata,draft:{...app.draft,role:'助手',memory:{enabled:true,automaticCandidates:false,maxItems:8,tokenBudget:1500},model:{providerProfileId:model.id,expectedRevision:model.revision,temperature:0,maxOutputTokens:1024}}})).app;
    ok(await window.desktop.apps({operation:'publish',appId:app.id,expectedVersion:app.version}));
  },`http://127.0.0.1:${server.address().port}/v1`);
  await page.reload();await ready(page);await page.getByRole('button',{name:'打开应用',exact:true}).click();await page.getByRole('button',{name:'新建对话',exact:true}).click();
  await page.getByLabel('输入任务',{exact:true}).fill('中文偏好 UI_MEMORY_ORIGINAL');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('确定性记忆测试回复',{exact:true}).waitFor();await page.getByRole('button',{name:'记住这条',exact:true}).first().click();
  assert.equal(await page.getByLabel('记忆内容',{exact:true}).inputValue(),'中文偏好 UI_MEMORY_ORIGINAL');
  await page.getByLabel('记忆内容',{exact:true}).fill('中文偏好 UI_MEMORY_CONFIRMED');await page.getByRole('button',{name:'确认保存记忆',exact:true}).click();
  await page.getByTestId('memory-feedback').filter({hasText:'记忆已保存'}).waitFor();
  const memoryPage=page.getByLabel('应用记忆管理',{exact:true});
  await page.getByLabel('按类型筛选',{exact:true}).selectOption('term');await until(async()=>await memoryPage.getByRole('button',{name:'编辑',exact:true}).count()===0);
  await page.getByLabel('按类型筛选',{exact:true}).selectOption('preference');await page.getByRole('button',{name:'跳转来源',exact:true}).click();
  await page.getByText('中文偏好 UI_MEMORY_ORIGINAL',{exact:true}).waitFor();
  await page.getByRole('button',{name:'管理应用记忆',exact:true}).click();await page.getByRole('button',{name:'从新会话开始',exact:true}).click();
  await page.getByLabel('输入任务',{exact:true}).fill('请使用中文偏好');await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('确定性记忆测试回复',{exact:true}).waitFor();assert.match(JSON.stringify(requests.at(-1)),/UI_MEMORY_CONFIRMED/);assert.doesNotMatch(JSON.stringify(requests.at(-1)),/UI_MEMORY_ORIGINAL/);
  const used=page.getByLabel('本轮使用记忆',{exact:true});await used.getByText('偏好 · v1',{exact:true}).click();await used.getByText('中文偏好 UI_MEMORY_CONFIRMED',{exact:true}).waitFor();
  await page.getByRole('button',{name:'管理应用记忆',exact:true}).click();await memoryPage.getByRole('button',{name:'编辑',exact:true}).click();await page.getByLabel('记忆内容',{exact:true}).fill('中文偏好 UI_MEMORY_V2');await page.getByRole('button',{name:'确认保存记忆',exact:true}).click();await page.getByTestId('memory-feedback').filter({hasText:'记忆已保存'}).waitFor();
  await page.getByRole('button',{name:'返回聊天',exact:true}).click();await used.getByText('偏好 · v1',{exact:true}).click();await used.getByText('中文偏好 UI_MEMORY_CONFIRMED',{exact:true}).waitFor();
  await page.getByRole('button',{name:'管理应用记忆',exact:true}).click();await page.getByRole('button',{name:'停用',exact:true}).click();await page.getByText(/v3 · disabled/).waitFor();
  await page.getByRole('button',{name:'删除',exact:true}).click();await page.getByRole('button',{name:'确认删除记忆',exact:true}).click();await page.getByTestId('memory-feedback').filter({hasText:'已删除'}).waitFor();
  await page.getByRole('button',{name:'从新会话开始',exact:true}).click();await page.getByLabel('输入任务',{exact:true}).fill('请使用中文偏好');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('确定性记忆测试回复',{exact:true}).waitFor();
  assert.doesNotMatch(JSON.stringify(requests.at(-1)),/UI_MEMORY_|reference-memories/);
  t.diagnostic('Deterministic model; real Electron IPC, MemoryService, SQLite, Pi and Windows. Not real-model M01/M10 acceptance.');
});

test('H02/H05/H06/H07 candidate conflict review and Chinese memory/message search through production desktop/host/model worker', {timeout:90000},async t=>{
  const requests=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
    const extracting=body.messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.includes('Extract durable'));
    const answer=extracting?JSON.stringify({candidates:[{type:'preference',content:'回答偏好：简短中文',subject:'回答偏好'}]}):'候选测试对话已完成';
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[{role:'assistant',content:answer},null],[{},'stop']])res.write('data: '+JSON.stringify({id:'candidate-ui',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const {page}=await launch(t);await ready(page);
  const appId=await page.evaluate(async endpoint=>{
    const ok=r=>{if(!r.ok)throw Error(r.error.message);return r.value;};
    const model=ok(await window.desktop.providers({operation:'save',input:{config:{name:'Candidate fixture',providerType:'local-openai',endpoint,modelId:'fixture',authMode:'none',settings:{timeoutMs:10000}},credential:{action:'clear'}}})).profile;
    const metadata={name:'候选审核界面测试',description:'',icon:'book',category:'',favorite:false};let app=ok(await window.desktop.apps({operation:'create',metadata})).app;
    if(app.draft.memory.automaticCandidates!==false)throw Error('not disabled by default');
    app=ok(await window.desktop.apps({operation:'update',appId:app.id,expectedVersion:app.version,metadata,draft:{...app.draft,role:'助手',memory:{enabled:true,automaticCandidates:true,maxItems:8,tokenBudget:1500},model:{providerProfileId:model.id,expectedRevision:model.revision,temperature:0,maxOutputTokens:1024}}})).app;
    ok(await window.desktop.apps({operation:'publish',appId:app.id,expectedVersion:app.version}));
    ok(await window.desktop.memories({operation:'save',appId:app.id,content:'回答偏好：详细英文',type:'preference',priority:0,expiresAt:null,confirmed:true}));return app.id;
  },`http://127.0.0.1:${server.address().port}/v1`);
  await page.reload();await ready(page);await page.getByRole('button',{name:'打开应用',exact:true}).click();await page.getByRole('button',{name:'新建对话',exact:true}).click();
  await page.getByLabel('输入任务',{exact:true}).fill('回答偏好：简短中文 UI_SOURCE_UNIQUE');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('候选测试对话已完成',{exact:true}).waitFor();
  await until(async()=>{const r=await page.evaluate(appId=>window.desktop.memories({operation:'candidates',appId}),appId);return r.ok&&r.value.total===1;});
  const extraction=requests.find(body=>body.messages.some(m=>m.role==='system'&&typeof m.content==='string'&&m.content.includes('Extract durable')));assert.equal(extraction.tools,undefined);assert.equal(extraction.max_tokens,1024);
  await page.getByRole('button',{name:'管理应用记忆',exact:true}).click();const panel=page.getByLabel('候选审核',{exact:true});
  await panel.getByText('回答偏好：简短中文',{exact:true}).waitFor();await panel.getByText('回答偏好：详细英文',{exact:true}).waitFor();
  await panel.getByText('查看来源消息',{exact:true}).click();await panel.getByText('回答偏好：简短中文 UI_SOURCE_UNIQUE',{exact:true}).waitFor();
  await panel.getByRole('textbox').fill('回答偏好：简短中文，附英文详情');await panel.getByRole('button',{name:'确认合并为编辑内容',exact:true}).click();await panel.getByText('暂无待审核候选。',{exact:true}).waitFor();
  const search=page.getByLabel('中文搜索',{exact:true});await search.getByLabel('搜索词',{exact:true}).fill('简短中文');await search.getByRole('button',{name:'搜索',exact:true}).click();await search.getByText('共 1 条结果',{exact:true}).waitFor();
  await search.getByLabel('搜索范围',{exact:true}).selectOption('message');await search.getByLabel('搜索词',{exact:true}).fill('UI_SOURCE_UNIQUE');await search.getByRole('button',{name:'搜索',exact:true}).click();await search.getByText('回答偏好：简短中文 UI_SOURCE_UNIQUE',{exact:true}).first().waitFor();
  await search.getByRole('button',{name:'跳转会话',exact:true}).click();await page.getByLabel('输入任务',{exact:true}).waitFor();
  const accepted=await page.evaluate(appId=>window.desktop.memories({operation:'list',appId}),appId);assert.equal(accepted.value.memories.filter(m=>m.status==='active').length,1);assert.equal(accepted.value.memories.filter(m=>m.status==='disabled').length,1);
  t.diagnostic('Actual Windows Electron/preload/Host/Pi/extraction worker/SQLite with deterministic SSE only. Real-model and human acceptance remain pending.');
});

test('File F01/F02/F03/F07/F10 desktop attachment selection, removal, import failure and inert artifact preview through real IPC/Pi', { timeout:60000 },async t => {
  const { app,page,profile } = await launch(t); await ready(page);
  const malicious = '<script>window.PWNED=1</script><img src="https://invalid.example/pixel" onerror="alert(1)">';
  const server = createServer(async (req,res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const last = JSON.parse(raw).messages.at(-1), text = typeof last.content === 'string' ? last.content : last.content.filter(c => c.type === 'text').map(c => c.text).join('');
    res.writeHead(200,{ 'content-type':'text/event-stream' });
    const send = (delta,finish_reason = null) => res.write('data: '+JSON.stringify({ id:'file-ui',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{ index:0,delta,finish_reason }] })+'\n\n');
    if (last.role === 'user') {
      const grantId = JSON.parse(text.slice(0,text.indexOf('\n'))).grantId;
      const content = text.match(/<attachment id="[^"]+">\n([\s\S]*?)\n<\/attachment>/)?.[1];
      assert.equal(content,malicious);
      send({ role:'assistant',tool_calls:[{ index:0,id:'ui-output',type:'function',function:{ name:'platform_output',arguments:JSON.stringify({ grantId,path:'result.txt',content }) } }] });
      send({},'tool_calls');
    } else { send({ role:'assistant',content:'已生成文件' }); send({},'stop'); }
    res.end('data: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const scope = await page.evaluate(async endpoint => {
    const ok = result => { if (!result.ok) throw Error(result.error.message); return result.value; };
    const model = ok(await window.desktop.providers({ operation:'save',input:{ config:{ name:'File fixture',providerType:'local-openai',endpoint,modelId:'fixture',authMode:'none',settings:{ timeoutMs:10000 } },credential:{ action:'clear' } } })).profile;
    const metadata = { name:'文件闭环测试',description:'',icon:'book',category:'',favorite:false };
    let application = ok(await window.desktop.apps({ operation:'create',metadata })).app;
    application = ok(await window.desktop.apps({ operation:'update',appId:application.id,expectedVersion:application.version,metadata,draft:{ ...application.draft,role:'File fixture',permissions:{ mode:'controlled-files',tools:['write'] },model:{ providerProfileId:model.id,expectedRevision:model.revision,temperature:0,maxOutputTokens:1024 } } })).app;
    application = ok(await window.desktop.apps({ operation:'publish',appId:application.id,expectedVersion:application.version })).app;
    const conversation = ok(await window.desktop.chat({ operation:'create',appId:application.id,conversationId:crypto.randomUUID(),title:'文件测试会话' })).conversation;
    const scope = { appId:application.id,conversationId:conversation.id };
    const grant = ok(await window.desktop.policy({ operation:'grants.create',...scope,resource:'output',access:'write',confirmation:'never' })).grant;
    return { ...scope,grantId:grant.id };
  },`http://127.0.0.1:${server.address().port}/v1`);
  await page.reload(); await ready(page);
  await page.getByTestId('app-card').getByRole('button',{ name:'打开应用',exact:true }).click();
  await page.getByRole('button',{ name:'文件测试会话',exact:true }).click();
  const source = join(profile,'中文 附件.txt'); await writeFile(source,malicious);
  await app.evaluate(({ dialog },path) => { dialog.showOpenDialog = async () => ({ canceled:false,filePaths:[path] }); },source);
  await page.getByRole('button',{ name:'添加文本附件',exact:true }).click();
  await page.getByLabel('输入附件',{ exact:true }).getByText('导入完成',{ exact:true }).waitFor();
  await page.getByRole('button',{ name:'移除输入引用',exact:true }).click();
  assert.equal(await page.getByRole('button',{ name:'移除输入引用',exact:true }).count(),0);
  await page.getByRole('button',{ name:'添加文本附件',exact:true }).click();
  await page.getByRole('button',{ name:'移除输入引用',exact:true }).waitFor();
  await writeFile(source,'changed original');
  await page.getByLabel('输入任务',{ exact:true }).fill(JSON.stringify({ grantId:scope.grantId }));
  await page.getByRole('button',{ name:'发送',exact:true }).click();
  await page.getByText('已生成文件',{ exact:true }).waitFor();
  const panel = page.getByTestId('file-panel'); await panel.getByText('result.txt',{ exact:true }).waitFor();
  await panel.getByRole('button',{ name:'安全预览',exact:true }).click();
  await page.getByLabel('安全文件预览',{ exact:true }).getByText(malicious,{ exact:true }).waitFor();
  assert.equal(await page.evaluate(() => window.PWNED),undefined);
  assert.equal(await page.getByLabel('安全文件预览',{ exact:true }).locator('script,img,iframe,object,a').count(),0);
  assert.equal((await page.evaluate(({ appId,conversationId }) => window.desktop.files({ operation:'artifacts.preview',appId,conversationId,artifactId:crypto.randomUUID(),path:'C:\\Windows\\win.ini' }),scope)).error.code,'INVALID_INPUT');
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled:false,filePaths:['C:\\missing-input.txt'] }); });
  await page.getByRole('button',{ name:'添加文本附件',exact:true }).click();
  await page.getByLabel('输入附件',{ exact:true }).getByText(/导入失败/).waitFor();
  assert.equal(await (await import('node:fs/promises')).readFile(source,'utf8'),'changed original');
});

test('K01/K04 desktop library imports through Main dialog token and edits exact version/mode bindings', { timeout:60000 }, async t => {
  const { app,page,profile } = await launch(t); await ready(page);
  const source = join(profile,'中文 Skill 源包'); await mkdir(source);
  await writeFile(join(source,'SKILL.md'),'---\nname: ui-skill\ndescription: 桌面导入样例\nallowed-tools: shell\n---\nNo scripts.');
  // Simulate only the OS picker result in trusted Main; the production preload/IPC/service remain real.
  await app.evaluate(({ dialog },path) => { dialog.showOpenDialog = async () => ({ canceled:false,filePaths:[path] }); },source);
  await page.getByRole('button',{ name:'技能库',exact:true }).click();
  await page.getByRole('button',{ name:'导入 Skill 文件夹',exact:true }).click();
  await page.getByTestId('skill-library').getByText('导入成功。',{ exact:true }).waitFor();
  await page.getByTestId('skill-report').getByText('静态校验通过',{ exact:true }).waitFor();
  await page.getByTestId('skill-report').getByText('allowed-tools：shell。这些声明不授予实际工具权限。',{ exact:true }).waitFor();
  const result = await page.evaluate(() => window.desktop.skills({ operation:'list',limit:100,offset:0 }));
  assert.equal(result.ok,true); const skill = result.value.skills[0]; assert.equal(skill.versionOrigin,'platform');
  assert.equal((await page.evaluate(path => window.desktop.skills({ operation:'import',path }),source)).error.code,'INVALID_INPUT');
  await page.getByRole('button',{ name:'创建应用',exact:true }).click();
  await page.getByLabel('应用名称',{ exact:true }).fill('Skill 绑定应用');
  await page.getByLabel('选择 Skill 版本',{ exact:true }).selectOption(`${skill.id}:${skill.version}`);
  await page.getByLabel(`调用模式 ${skill.id}`,{ exact:true }).selectOption('explicit');
  await page.getByLabel(`启用 ${skill.id}`,{ exact:true }).uncheck();
  await page.getByRole('button',{ name:'保存应用草稿',exact:true }).click();
  await page.getByTestId('app-feedback').filter({ hasText:'草稿已保存' }).waitFor();
  const apps = await page.evaluate(() => window.desktop.apps({ operation:'list',query:'',archived:false,sort:'name',limit:100,offset:0 }));
  assert.equal(apps.value.apps[0].draft.skills[0].hash,skill.sha256); assert.equal(apps.value.apps[0].draft.skills[0].enabled,false);
  assert.equal(apps.value.apps[0].draft.skills[0].invocationMode,'explicit'); assert.deepEqual(apps.value.apps[0].draft.permissions.tools,[]);
  await page.reload(); await ready(page); await page.getByRole('button',{ name:'技能库',exact:true }).click();
  await page.getByTestId('skill-library').getByRole('button',{ name:'查看详情',exact:true }).click();
  await page.getByRole('button',{ name:'重新校验完整性与依赖',exact:true }).click();
  await page.getByTestId('skill-report').getByText('静态校验通过',{ exact:true }).waitFor();
});

test('A01/A02/A07/A08 desktop app management uses forms, persists after service restart and opens no Worker', { timeout: 60000 }, async t => {
  const { page } = await launch(t); await ready(page);
  const pid = (await page.evaluate(() => window.desktop.getStatus())).value.pid;
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await page.getByLabel('应用名称', { exact: true }).fill('桌面写作助手');
  await page.getByLabel('应用简介', { exact: true }).fill('中文描述');
  await page.getByLabel('角色说明', { exact: true }).fill('协助整理文稿');
  await page.getByLabel('输出要求', { exact: true }).fill('清晰简洁');
  await page.getByLabel('分类', { exact: true }).fill('文稿');
  await page.getByLabel('图标', { exact: true }).selectOption('book');
  await page.getByLabel('收藏应用', { exact: true }).check();
  await page.getByRole('button', { name: '保存应用草稿', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '草稿已保存' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '发布配置版本', exact: true }).isDisabled(), true);
  const card = page.getByTestId('app-card').filter({ hasText: '桌面写作助手' });
  await card.getByText('配置未完成', { exact: true }).waitFor();
  // Controlled no-auth profile: configuration-only acceptance, no connection test or model request.
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('显示名称', { exact: true }).fill('应用配置测试模型');
  await page.getByLabel('协议', { exact: true }).selectOption('local-openai');
  await page.getByLabel('模型 ID', { exact: true }).fill('controlled-not-live-tested');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '刷新模型选项', exact: true }).click();
  await page.getByLabel('应用模型', { exact: true }).selectOption({ label: '应用配置测试模型 · controlled-not-live-tested · v1' });
  await page.getByRole('button', { name: '保存应用草稿', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '草稿已保存' }).waitFor();
  // Legacy app-service publication remains available; the creation wizard now requires a real trial.
  assert.equal(await page.getByRole('button', { name: '发布配置版本', exact: true }).isDisabled(),true);
  await page.evaluate(async () => {
    const list = await window.desktop.apps({ operation:'list',query:'',archived:false,sort:'name',limit:100,offset:0 });
    const app = list.value.apps[0];
    await window.desktop.apps({ operation:'publish',appId:app.id,expectedVersion:app.version });
  });
  await page.getByRole('button', { name: '重新加载应用', exact: true }).click();
  await page.getByRole('button', { name: '刷新应用列表', exact: true }).click();
  await card.getByText('可使用（配置就绪）', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  await page.getByLabel('搜索应用', { exact: true }).fill('中文描述');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await card.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
  await card.getByRole('button', { name: '打开应用', exact: true }).click();
  await page.getByTestId('app-space').getByText('从左侧选择会话或新建对话。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '新建对话', exact: true }).isDisabled(), false);
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.pid, pid);
  await page.getByRole('button', { name: '返回应用首页', exact: true }).click();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('应用名称', { exact: true }).fill('桌面改名助手');
  await page.getByRole('button', { name: '保存应用草稿', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '草稿已保存' }).waitFor();
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  // Restart the real sidecar, then remount UI; no in-memory storage can satisfy this check.
  process.kill(pid);
  await page.waitForFunction(() => document.querySelector('[data-testid="phase"]').getAttribute('data-phase') === 'failed');
  await wait(300); await page.getByRole('button', { name: '重试服务', exact: true }).click(); await ready(page);
  await page.reload(); await ready(page);
  const renamed = page.getByTestId('app-card').filter({ hasText: '桌面改名助手' });
  await renamed.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
  await renamed.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '模型关联和外部目录授权需重新配置' }).waitFor();
  assert.equal(await page.getByLabel('应用模型', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  const original = page.getByTestId('app-card').filter({ has: page.getByRole('heading', { name: '▤ 桌面改名助手', exact: true }) });
  await original.getByRole('button', { name: '归档', exact: true }).click();
  await original.waitFor({ state: 'detached' });
  await page.getByLabel('查看已归档', { exact: true }).check();
  await original.getByText('已归档', { exact: true }).waitFor();
  assert.equal(await original.getByRole('button', { name: '打开应用', exact: true }).isDisabled(), true);
  await original.getByRole('button', { name: '恢复', exact: true }).click();
  await original.waitFor({ state: 'detached' });
  await page.getByLabel('查看已归档', { exact: true }).uncheck(); await original.waitFor();
  const invalid = await page.evaluate(() => window.desktop.apps({ operation: 'writeFile', path: 'x' }));
  assert.equal(invalid.error.code, 'INVALID_INPUT');
});

test('P17 production settings: manual save/probe, revision invalidation and transient key clearing', { timeout: 60000 }, async t => {
  let requests = 0;
  const authorization = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    requests++;
    authorization.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { page } = await launch(t); await ready(page);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('显示名称').fill('Local UI test');
  await page.getByLabel('协议', { exact: true }).selectOption('local-openai');
  await page.getByLabel('端点', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('模型 ID', { exact: true }).fill('test-model');
  assert.equal(requests, 0);
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  assert.equal(requests, 0);
  await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
  await page.getByTestId('provider-result').filter({ hasText: '连接成功' }).waitFor();
  assert.equal(requests, 1);
  await page.getByLabel('模型 ID', { exact: true }).fill('edited-model');
  assert.equal(await page.getByTestId('provider-result').count(), 0);
  assert.equal(await page.getByRole('button', { name: '测试模型连接', exact: true }).isDisabled(), true);
  await page.getByLabel('模型 ID', { exact: true }).fill('test-model');
  assert.equal(await page.getByTestId('provider-result').count(), 0);
  await page.getByLabel('模型 ID', { exact: true }).fill('edited-model');
  await page.getByLabel('认证方式', { exact: true }).selectOption('api-key');
  await page.getByLabel('API Key', { exact: true }).fill('transient-ui-test-key');
  // Invalid request must still clear the password immediately and never touch browser storage.
  await page.getByLabel('模型 ID', { exact: true }).fill('');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await page.getByTestId('provider-feedback').filter({ hasText: '请求格式无效' }).waitFor();
  await page.getByLabel('模型 ID', { exact: true }).fill('edited-model');
  await page.getByLabel('API Key', { exact: true }).fill('saved-ui-test-key');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
  await page.getByTestId('provider-result').filter({ hasText: '连接成功' }).waitFor();
  assert.deepEqual(authorization, [undefined, 'Bearer saved-ui-test-key']);
  await page.getByLabel('API Key', { exact: true }).fill('leave-page-test-key');
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(requests, 2);
  assert.equal((await page.evaluate(() => window.desktop.providers({ operation: 'readCredential' }))).error.code, 'INVALID_INPUT');
});

test('D01/D06 desktop DeepSeek defaults, required replacement key, persisted reload and secret clearing', { timeout: 60000 }, async t => {
  const { page } = await launch(t); await ready(page);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('显示名称').fill('Cloud UI test');
  await page.getByLabel('模型 ID', { exact: true }).fill('openai-test-model');
  await page.getByLabel('API Key', { exact: true }).fill('openai-ui-test-key');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  await page.getByLabel('API Key', { exact: true }).fill('transient-other-provider-key');
  await page.getByLabel('协议', { exact: true }).selectOption('deepseek');
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('端点', { exact: true }).inputValue(), 'https://api.deepseek.com');
  assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'deepseek-flash');
  // Check the option itself: Playwright's disabled-state query can retarget to
  // the enclosing labelled select, which remains enabled for authentication.
  assert.equal(await page.getByRole('option', { name: '无需认证', exact: true }).evaluate(option => option.disabled), true);
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '请求格式无效' }).waitFor();
  const old = await page.evaluate(() => window.desktop.providers({ operation: 'list' }));
  assert.equal(old.value.profiles[0].providerType, 'openai');
  await page.getByLabel('API Key', { exact: true }).fill('deepseek-ui-test-key');
  await page.getByLabel('超时（毫秒）', { exact: true }).fill('60000');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  const listed = await page.evaluate(() => window.desktop.providers({ operation: 'list' }));
  const p = listed.value.profiles[0];
  assert.equal(p.providerType, 'deepseek'); assert.equal(p.revision, 2);
  assert.ok((await page.getByTestId('provider-identity').textContent()).includes(p.id));
  assert.doesNotMatch(JSON.stringify(listed), /secretRef|ui-test-key/);
  await page.reload(); await ready(page);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('button', { name: 'Cloud UI test · deepseek-flash · v2', exact: true }).click();
  assert.equal(await page.getByLabel('协议', { exact: true }).inputValue(), 'deepseek');
  assert.equal(await page.getByLabel('超时（毫秒）', { exact: true }).inputValue(), '60000');
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  // No test button clicked: saving a cloud profile must never send a model request.
  assert.equal(await page.getByTestId('provider-result').count(), 0);
});

test('F01/F02/F03/F10/F11 production Electron: real call chain, sandbox, reload and single instance', { timeout: 60000 }, async (t) => {
  const { app, page, profile } = await launch(t); await ready(page);
  await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByTestId('diagnostic').filter({ hasText: 'Node 24.19.0' }).waitFor();
  const initial = await page.evaluate(() => window.desktop.getStatus());
  const pid = initial.value.pid;
  const surface = await page.evaluate(() => ({ keys: Object.keys(window.desktop).sort(), require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer }));
  assert.deepEqual(surface, { keys: ['apps', 'chat', 'data', 'files', 'getStatus', 'memories', 'onStatusChanged', 'openExternal', 'ping', 'policy', 'providers', 'retryService', 'runs', 'selectAttachment', 'selectData', 'selectGrantDirectory', 'selectSkillDirectory', 'selectTrustedAutomation', 'skills'], require: 'undefined', process: 'undefined', ipc: 'undefined' });
  const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(prefs[key], true);
  for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag', 'allowRunningInsecureContent']) assert.equal(prefs[key], false, key);
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.openDevTools({ mode: 'detach' });
    return contents.isDevToolsOpened();
  }), false);
  assert.equal((await page.evaluate(() => window.desktop.ping({ text: 'x', exec: 'bad' }))).error.code, 'INVALID_INPUT');
  assert.equal((await page.evaluate(() => window.desktop.policy({ operation: 'execute', tool: 'bash', args: {} }))).error.code, 'INVALID_INPUT');
  assert.equal((await page.evaluate(() => window.desktop.selectGrantDirectory({ path: 'C:\\Windows' }))).error.code, 'INVALID_INPUT');
  assert.equal((await page.evaluate(() => window.desktop.selectTrustedAutomation({ approved: true }))).error.code, 'INVALID_INPUT');
  assert.equal(await page.evaluate(async () => { try { await fetch('file:///C:/Windows/win.ini'); return true; } catch { return false; } }), false);
  assert.equal(await page.evaluate(async () => { try { await fetch('https://example.com'); return true; } catch { return false; } }), false);
  await page.evaluate(() => window.open('https://example.com'));
  assert.equal(app.windows().length, 1);
  // A second real renderer with a test-only probe cannot impersonate the owning window.
  const probe = join(profile, 'probe.cjs');
  await writeFile(probe, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',(channel='foundation:status')=>ipcRenderer.invoke(channel,{}));");
  const foreignPagePromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, preload) => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await other.loadURL('app://desktop/index.html');
  }, probe);
  const foreignPage = await foreignPagePromise;
  assert.equal((await foreignPage.evaluate(() => window.probe())).error.code, 'FORBIDDEN');
  for (const channel of ['policy:request', 'policy:select', 'policy:trust']) assert.equal((await foreignPage.evaluate(channel => window.probe(channel), channel)).error.code, 'FORBIDDEN');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isVisible()).destroy());
  for (let i = 0; i < 3; i++) { await page.reload(); await ready(page); assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.pid, pid); }
  const second = spawn(electronPath, [resolve('dist'), `--user-data-dir=${profile}`], { env: environment(), stdio: 'ignore', windowsHide: true });
  const [exitCode] = await once(second, 'exit'); assert.equal(exitCode, 0);
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.pid, pid);
  assert.equal(app.windows().length, 1);
  // Normal window close must shut down the actual sidecar.
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed; await until(() => !alive(pid));
});

test('F06/F07/F08/F12 real crash notification, subscription cleanup, manual retry and Main crash cleanup', { timeout: 60000 }, async (t) => {
  const { app, page } = await launch(t); await ready(page);
  await page.evaluate(() => {
    window.events = [];
    window.removedEvents = [];
    const off = window.desktop.onStatusChanged((s) => window.removedEvents.push(s)); off(); off();
    window.desktop.onStatusChanged((s) => window.events.push(s));
  });
  const old = (await page.evaluate(() => window.desktop.getStatus())).value.pid;
  process.kill(old);
  await page.waitForFunction(() => document.querySelector('[data-testid="phase"]').getAttribute('data-phase') === 'failed');
  assert.equal(await page.getByRole('button', { name: '检查连接' }).isDisabled(), true);
  assert.equal((await page.evaluate(() => window.desktop.ping({ text: 'no replay' }))).error.code, 'NOT_READY');
  await wait(300);
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.phase, 'failed');
  await page.getByRole('button', { name: '重试服务' }).click(); await ready(page);
  const current = (await page.evaluate(() => window.desktop.getStatus())).value.pid;
  assert.notEqual(current, old);
  const events = await page.evaluate(() => ({ kept: window.events, removed: window.removedEvents }));
  assert.deepEqual(events.removed, []);
  assert.deepEqual(events.kept.map((s) => s.phase), ['failed', 'starting', 'ready']);
  // Electron's launcher PID can differ from its actual Main PID on Windows.
  const mainPid = await app.evaluate(() => process.pid);
  process.kill(mainPid);
  await until(() => !alive(current));
});

test('F05/F07/F14 missing sidecar is visible and retryable in a Chinese and spaced application path', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(resolve('.test-app-中文 空格-'));
  await cp(resolve('dist'), root, { recursive: true });
  const runtime = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  await rename(runtime, `${runtime}.disabled`);
  const { page } = await launch(t, root);
  // Hooks run in registration order; close the application before deleting its runtime.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await page.waitForFunction(() => document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase') === 'failed');
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.error.code, 'START_FAILED');
  await rename(`${runtime}.disabled`, runtime);
  await page.getByRole('button', { name: '重试服务' }).click(); await ready(page);
  assert.equal((await page.evaluate(() => window.desktop.ping({ text: '中文路径' }))).value.text, '中文路径');
});
