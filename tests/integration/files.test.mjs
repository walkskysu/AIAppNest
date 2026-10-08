import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { writeFileSync, readFileSync, readdirSync, existsSync, unlinkSync, symlinkSync, mkdirSync, linkSync } from 'node:fs';
import { FileService, fixture, runtime, ok, until, RunScheduler } from './fixtures/engine-harness.mjs';

function client(f,service = f.services.files) {
  const scope = { appId:f.app.id,conversationId:f.conversation.id }, owner = randomUUID();
  const request = (operation,extra = {}) => service.request({ operation:'request',owner,request:{ operation,...scope,...extra } });
  const select = path => service.request({ operation:'select',owner,...scope,path });
  const importFile = async (path) => { const selection = ok(await select(path)).selection; return ok(await request('attachments.import',{ token:selection.token })).reply.file; };
  return { scope,owner,request,select,importFile,service };
}
function source(f,name = '输入 中文 空格.txt',content = 'original input') { const path = join(f.root,name); writeFileSync(path,content); return path; }
function artifact(f,path) { return f.services.files.registerOutput({ appId:f.app.id,conversationId:f.conversation.id,runId:f.run() },path); }
const rows = f => f.storage.attachments.list({ appId:f.app.id,conversationId:f.conversation.id });

test('F01/F02 real Pi + scheduler + controlled output consumes imported copy, registers correct run; fixture model only', { timeout:30000 },async t => {
  const f = await fixture(t,{ files:true,fileFlow:true,permissions:{ mode:'controlled-files',tools:['write'] } }), c = client(f);
  const path = source(f), attachment = await c.importFile(path); writeFileSync(path,'source changed after import');
  const grant = f.policyRequest({ operation:'grants.create',resource:'output',access:'write',confirmation:'never' }).grant;
  const outputRoot = f.storage.paths.conversation(f.app.id,f.conversation.id,'artifacts'); writeFileSync(join(outputRoot,'old.txt'),'preexisting');
  const scheduler = new RunScheduler(f.services,runtime); f.schedulers.push(scheduler);
  const run = ok(scheduler.request({ operation:'submit',...c.scope,revisionId:f.conversation.revisionId,requestId:randomUUID(),text:JSON.stringify({ grantId:grant.id }),attachmentIds:[attachment.id] })).run;
  await until(() => f.storage.runs.get({ appId:f.app.id,id:run.id }).phase === 'completed');
  assert.equal(f.storage.runs.get({ appId:f.app.id,id:run.id }).state,'succeeded');
  const listed = ok(await c.request('artifacts.list',{ runId:run.id })).reply.files;
  assert.equal(listed.length,1); assert.equal(listed[0].displayName,'fixture-result.txt'); assert.equal(listed[0].runId,run.id);
  assert.equal(ok(await c.request('artifacts.preview',{ artifactId:listed[0].id })).reply.preview.text,'copied:original input');
  assert.ok(JSON.stringify(f.requests).includes('original input')); assert.ok(!JSON.stringify(f.requests).includes('source changed after import'));
  assert.ok(!JSON.stringify(f.requests).includes(path));
});

test('F03 tokens are expiring, one-shot, document/session bound; IDs and path injection reject',async t => {
  const f = await fixture(t); let now = 1;
  const c = client(f,new FileService(f.storage,{ now:() => now })), path = source(f);
  const selection = ok(await c.select(path)).selection;
  const foreign = f.storage.createConversation(f.app.id,randomUUID(),'foreign');
  assert.equal((await c.request('attachments.import',{ token:selection.token,conversationId:foreign.id })).ok,false);
  assert.equal((await c.service.request({ operation:'request',owner:randomUUID(),request:{ operation:'attachments.import',...c.scope,token:selection.token } })).ok,false);
  now = selection.expiresAt; assert.equal((await c.request('attachments.import',{ token:selection.token })).ok,false);
  const next = ok(await c.select(path)).selection;
  const imported = ok(await c.request('attachments.import',{ token:next.token })).reply.file;
  assert.equal((await c.request('attachments.import',{ token:next.token })).ok,false);
  assert.throws(() => c.service.attachmentText({ ...c.scope,conversationId:foreign.id },[imported.id]));
  const file = artifact(f,source(f,'result.txt'));
  for (const operation of ['artifacts.preview','artifacts.open']) {
    const extra = { artifactId:file.id,...(operation.endsWith('open') ? { mode:'folder' } : {}) };
    assert.equal((await c.request(operation,{ ...extra,conversationId:foreign.id })).ok,false);
    assert.equal((await c.request(operation,{ ...extra,appId:randomUUID() })).ok,false);
    assert.equal((await c.request(operation,{ ...extra,path })).error.code,'INVALID_INPUT');
  }
  assert.equal((await c.request('artifacts.list',{ conversationId:foreign.id,runId:file.runId })).ok,false);
});

test('F04 managed file replacement with junction or hardlink cannot be previewed or opened',async t => {
  const f = await fixture(t), c = client(f), file = artifact(f,source(f,'result.txt'));
  const path = join(f.storage.paths.root,file.relativePath), data = readFileSync(path);
  unlinkSync(path); linkSync(source(f,'outside.txt','outside'),path);
  assert.equal(ok(await c.request('artifacts.list')).reply.files[0].status,'forbidden');
  assert.equal((await c.request('artifacts.open',{ artifactId:file.id,mode:'folder' })).ok,false);
  unlinkSync(path); writeFileSync(path,data);
  // Replace the artifact parent by a junction to another directory, with identical bytes.
  const outside = join(f.root,'external'); mkdirSync(outside); writeFileSync(join(outside,file.id),data);
  unlinkSync(path);
  const { rmdirSync } = await import('node:fs'); rmdirSync(dirname(path)); symlinkSync(outside,dirname(path),'junction');
  assert.equal(ok(await c.request('artifacts.preview',{ artifactId:file.id })).reply.file.status,'forbidden');
  assert.equal((await c.request('artifacts.open',{ artifactId:file.id,mode:'external' })).ok,false);
});

test('F05 same names never overwrite; quotas include concurrent reservations, invalid UTF-8/type and Windows aliases reject',async t => {
  const f = await fixture(t), c = client(f,new FileService(f.storage,{ limits:{ session:10,total:10,attachment:10 } }));
  const path = source(f,'same.txt','12345');
  const a = await c.importFile(path), b = await c.importFile(path); assert.notEqual(a.id,b.id); assert.equal(rows(f).length,2);
  assert.equal((await c.select(source(f,'large.txt','12345678901'))).error.code,'FILE_QUOTA');
  const token = ok(await c.select(path)).selection.token; assert.equal((await c.request('attachments.import',{ token })).error.code,'FILE_QUOTA');
  assert.equal(rows(f).length,2);
  assert.equal((await c.select(source(f,'bad.exe','MZ'))).error.code,'FILE_TYPE');
  const plain = client(f), invalid = ok(await plain.select(source(f,'invalid.txt',Buffer.from([0xff,0])))).selection;
  assert.equal((await plain.request('attachments.import',{ token:invalid.token })).error.code,'FILE_TYPE');
  for (const name of ['CON.txt','x.txt:stream','../outside.txt','x.txt.']) assert.equal((await plain.select(join(f.root,name))).ok,false);
  const other = await fixture(t), concurrent = client(other,new FileService(other.storage,{ limits:{ total:5,session:5 } })), one = source(other,'one.txt','12345');
  const tokens = await Promise.all([concurrent.select(one),concurrent.select(one)]);
  const results = await Promise.all(tokens.map(r => concurrent.request('attachments.import',{ token:ok(r).selection.token })));
  assert.equal(results.filter(r => r.ok).length,1);
});

test('F06 explicit registration is idempotent by run/source/hash, creates changed versions, never sweeps old files',async t => {
  const f = await fixture(t), c = client(f), runId = f.run(), scope = { ...c.scope,runId };
  const path = source(f,'report.md','v1'); source(f,'old.txt','old');
  const a = c.service.registerOutput(scope,path), b = c.service.registerOutput(scope,path); assert.equal(a.id,b.id);
  writeFileSync(path,'v2'); const v2 = c.service.registerOutput(scope,path); assert.notEqual(v2.id,a.id);
  assert.equal(readFileSync(join(f.storage.paths.root,a.relativePath),'utf8'),'v1');
  assert.equal(ok(await c.request('artifacts.list')).reply.files.length,2);
  assert.equal(readFileSync(path,'utf8'),'v2');
});

test('F07 previews are inert text or raster only, dangerous outputs cannot open externally; invalid raster and limits are explicit',async t => {
  const f = await fixture(t), c = client(f), runId = f.run();
  const register = (name,content) => c.service.registerOutput({ ...c.scope,runId },source(f,name,content));
  const attack = '<script>globalThis.PWNED=1</script><img src="https://invalid.example/pixel" onerror="alert(1)">';
  for (const name of ['attack.html','attack.svg','attack.exe','attack.cmd','attack.lnk','attack.url']) {
    const file = register(name,attack), preview = ok(await c.request('artifacts.preview',{ artifactId:file.id })).reply;
    assert.equal(preview.preview.kind,'unavailable'); assert.equal(preview.file.externalOpen,false);
    assert.equal((await c.request('artifacts.open',{ artifactId:file.id,mode:'external' })).error.code,'FILE_TYPE');
  }
  const text = register('attack.md',attack), reply = ok(await c.request('artifacts.preview',{ artifactId:text.id })).reply;
  assert.equal(reply.preview.kind,'text'); assert.equal(reply.preview.text,attack);
  const badImage = register('fake.png',attack); assert.equal(ok(await c.request('artifacts.preview',{ artifactId:badImage.id })).reply.file.status,'type-mismatch');
  assert.equal((await c.request('artifacts.open',{ artifactId:badImage.id,mode:'external' })).ok,false);
  const png = register('pixel.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4eEAAAAASUVORK5CYII=','base64'));
  assert.equal(ok(await c.request('artifacts.preview',{ artifactId:png.id })).reply.preview.kind,'image');
  const big = register('big.txt','x'.repeat(256*1024+1)); assert.match(ok(await c.request('artifacts.preview',{ artifactId:big.id })).reply.preview.reason,/大小/);
  const external = ok(await c.request('artifacts.open',{ artifactId:png.id,mode:'external' }));
  assert.match(external.openPath,/\.png$/); assert.equal(readFileSync(external.openPath).toString('base64'),ok(await c.request('artifacts.preview',{ artifactId:png.id })).reply.preview.data);
});

test('F08 import cancellation/source mutation/ENOSPC/DB rollback leave no usable partial, retry succeeds',async t => {
  const f = await fixture(t), path = source(f,'fault.txt','initial');
  for (const phase of ['copied','publish','commit']) {
    const c = client(f,new FileService(f.storage,{ checkpoint:stage => { if (stage === phase) throw Object.assign(Error('fault'),{ code:phase === 'copied' ? 'ENOSPC' : 'SQLITE_FULL' }); } }));
    const token = ok(await c.select(path)).selection.token;
    assert.equal((await c.request('attachments.import',{ token })).ok,false); assert.equal(rows(f).length,0);
    const folder = f.storage.paths.conversation(f.app.id,f.conversation.id,'attachments'); assert.deepEqual(readdirSync(folder),[]);
  }
  const mutation = client(f,new FileService(f.storage,{ checkpoint:phase => { if (phase === 'copied') writeFileSync(path,'different source'); } }));
  const token = ok(await mutation.select(path)).selection.token;
  assert.equal((await mutation.request('attachments.import',{ token })).error.code,'FILE_CHANGED');
  const c = client(f), selected = ok(await c.select(path)).selection;
  const pending = c.request('attachments.import',{ token:selected.token });
  ok(await c.request('attachments.cancel',{ token:selected.token })); assert.equal((await pending).error.code,'FILE_CANCELLED');
  assert.equal(rows(f).length,0); assert.equal((await c.importFile(path)).status,'ready');
});

test('F08 failed controlled write registration reports tool failure and does not register partial artifact',async t => {
  const f = await fixture(t,{ files:true,permissions:{ mode:'controlled-files',tools:['write'] } }), c = client(f), runId = f.run();
  const path = source(f,'output.txt','data');
  for (const phase of ['copied','commit']) {
    const broken = new FileService(f.storage,{ checkpoint:stage => { if (phase === stage) throw Error('disk or database failure'); } });
    assert.throws(() => broken.registerOutput({ ...c.scope,runId },path));
    assert.equal(ok(await c.request('artifacts.list')).reply.files.length,0);
  }
  assert.equal(readFileSync(path,'utf8'),'data');
  const broken = new FileService(f.storage,{ checkpoint:phase => { if (phase === 'commit') throw Error('transaction failure'); } });
  f.services.files.registerOutput = broken.registerOutput.bind(broken);
  const grant = f.policyRequest({ operation:'grants.create',resource:'workspace',access:'write',confirmation:'never' }).grant;
  const boundary = f.services.policy.bindRun(f.app.id,runId);
  await assert.rejects(boundary.write(randomUUID(),{ grantId:grant.id,path:'failed.txt',content:'written but not registered' }));
  assert.equal(ok(await c.request('artifacts.list')).reply.files.length,0);
});

test('F09/F10 change/missing clear integrity, archives hide attachments but preserve owned artifacts and inventory; originals survive',async t => {
  const f = await fixture(t), c = client(f), original = source(f), attachment = await c.importFile(original);
  const file = artifact(f,source(f,'result.txt')), path = join(f.storage.paths.root,file.relativePath);
  writeFileSync(path,'tampered'); const changed = ok(await c.request('artifacts.list')).reply.files[0];
  assert.equal(changed.status,'changed'); assert.equal(changed.hash,null);
  assert.equal((await c.request('artifacts.open',{ artifactId:file.id,mode:'folder' })).ok,false);
  unlinkSync(path); assert.equal(ok(await c.request('artifacts.preview',{ artifactId:file.id })).reply.file.status,'missing');
  f.storage.transitionRun(f.app.id,file.runId,3,'succeeded'); f.storage.recycleConversation(f.app.id,f.conversation.id);
  assert.throws(() => c.service.attachmentText(c.scope,[attachment.id]));
  assert.equal((await c.select(original)).ok,false); assert.equal(ok(await c.request('artifacts.list')).reply.files.length,1);
  assert.equal(f.storage.managedFiles().length,2); assert.ok(f.storage.managedFiles().every(f => f.status === 'archived'));
  const leftover = join(f.storage.paths.conversation(f.app.id,f.conversation.id,'attachments'),`${randomUUID()}.partial`); writeFileSync(leftover,'crash remainder');
  assert.equal(c.service.inventory().extra[0].kind,'partial');
  assert.equal(readFileSync(original,'utf8'),'original input'); assert.ok(existsSync(join(f.storage.paths.root,rows(f)[0].relativePath)));
});

test('trusted automation registers only explicit workspace declaration, after confirmation; external file rejected',async t => {
  const f = await fixture(t,{ files:true,permissions:{ mode:'trusted-automation',tools:['write'] } }), c = client(f);
  ok(f.services.policy.request({ operation:'trust',...c.scope,notice:'可信自动化可运行通用文件与 shell 工具。进程代码可能读取当前账户文件和注入的凭据；独立目录、cwd、进程和提示词不是 Windows 安全沙箱。仅对信任的应用和 Skill 启用。' }));
  const workspace = f.storage.paths.conversation(f.app.id,f.conversation.id,'workspace'); f.storage.paths.ensureDirectory(workspace);
  writeFileSync(join(workspace,'declared.txt'),'declared'); writeFileSync(join(workspace,'old.txt'),'old');
  const runId = f.run(), worker = await f.start();
  const pending = worker.prompt(runId,'tool:'+JSON.stringify({ name:'platform_register_output',args:{ path:'declared.txt' } }));
  let approval;
  await until(() => { approval = f.policyRequest({ operation:'approvals.list',runId }).approvals.find(a => a.state === 'pending'); return !!approval; });
  f.policyRequest({ operation:'approvals.decide',runId,approvalId:approval.id,digest:approval.digest,decision:'allow' });
  assert.equal((await pending).status,'succeeded');
  assert.deepEqual(ok(await c.request('artifacts.list')).reply.files.map(f => f.displayName),['declared.txt']);
  const denied = await worker.prompt(f.run(),'tool:'+JSON.stringify({ name:'platform_register_output',args:{ path:source(f,'external.txt','external') } }));
  assert.ok(denied.toolErrors > 0);
  assert.equal(ok(await c.request('artifacts.list')).reply.files.length,1);
});
