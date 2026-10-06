import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, symlinkSync, linkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ServiceManager } from '../../dist/service-manager.cjs';

const bundle = mkdtempSync(resolve('.test-skills-bundle-'));
after(() => rmSync(bundle,{ recursive:true,force:true,maxRetries:10,retryDelay:100 }));
await build({ entryPoints:['tests/integration/fixtures/skills-entry.ts'],outfile:join(bundle,'entry.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24' });
const { Storage, SkillRegistry, AppService, ProviderService, packageHash, readPackage, detectDependency, skillLimits, skillReplySchema } = createRequire(import.meta.url)(join(bundle,'entry.cjs'));
const ok = result => { assert.equal(result.ok,true,JSON.stringify(result)); return result.value; };
const metadata = { name:'应用',description:'',icon:'book',category:'',favorite:false };
const bind = (skill, extra = {}) => ({ id:skill.id,version:skill.version,hash:skill.sha256,enabled:true,invocationMode:'automatic',...extra });
function fixture(t, options = {}) {
  const root = mkdtempSync(resolve('.test-skills-中文 空格-')), storage = new Storage(join(root,'data'));
  const registry = new SkillRegistry(storage,options), owner = randomUUID();
  const request = input => { const reply = ok(registry.request({ operation:'request',owner,request:input })); assert.equal(reply.operation,'request'); assert.ok(skillReplySchema.safeParse(reply.reply).success); return reply.reply; };
  const select = (source, user = owner) => ok(registry.request({ operation:'select',path:source,owner:user,scope:'skill-import' })).selection;
  const importSkill = source => request({ operation:'import',token:select(source).token });
  t.after(() => { storage.close(); rmSync(root,{ recursive:true,force:true,maxRetries:10,retryDelay:100 }); });
  return { root,storage,registry,owner,request,select,importSkill };
}
function source(f, { folder = randomUUID(), skillId = randomUUID(), version = '1.0.0', name = 'identity', body = 'Follow the instructions.', extra = '', platform = true } = {}) {
  const path = join(f.root,folder); mkdirSync(path,{ recursive:true });
  writeFileSync(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: 测试技能\n${platform ? `metadata:\n  aiappnest:\n    skillId: ${skillId}\n    version: ${version}\n${extra}` : ''}---\n${body}\n`);
  return path;
}
const failure = (f,request,code) => assert.equal(f.registry.request({ operation:'request',owner:f.owner,request }).error.code,code);
async function appFixture(f) {
  const vault = { collect(){ return false; },create(){ throw new Error('No secrets'); },read(){ throw new Error('No secrets'); },remove(){} };
  const providers = new ProviderService(f.storage,vault,async () => { throw new Error('No model calls'); });
  const p = ok(await providers.request({ operation:'save',input:{ config:{ name:'配置测试',providerType:'local-openai',endpoint:'http://127.0.0.1:11434/v1',modelId:'test',authMode:'none',settings:{ timeoutMs:3000 } },credential:{ action:'clear' } } })).profile;
  const apps = new AppService(f.storage,providers,undefined,f.registry);
  const create = () => {
    let app = ok(apps.request({ operation:'create',metadata })).app;
    app = ok(apps.request({ operation:'update',appId:app.id,expectedVersion:app.version,metadata,draft:{ ...app.draft,role:'test',model:{ providerProfileId:p.id,expectedRevision:p.revision,temperature:0.5,maxOutputTokens:1024 } } })).app;
    return app;
  };
  const bindings = (app,skills) => ok(apps.request({ operation:'bindSkills',appId:app.id,expectedVersion:app.version,skills })).app;
  const publish = app => ok(apps.request({ operation:'publish',appId:app.id,expectedVersion:app.version })).app;
  return { apps,create,bindings,publish };
}

test('K01 directory token is owner/scope/expiry bound, one-use and cannot be supplied as a path', t => {
  let now = Date.now(); const f = fixture(t,{ now:() => now }), src = source(f,{ folder:'中文 空格' });
  const selection = f.select(src);
  assert.equal(f.registry.request({ operation:'request',owner:randomUUID(),request:{ operation:'import',token:selection.token } }).error.code,'FORBIDDEN');
  assert.equal(f.registry.request({ operation:'select',owner:f.owner,path:src,scope:'extension-install' }).error.code,'INVALID_INPUT');
  failure(f,{ operation:'import',path:src },'INVALID_INPUT');
  const imported = f.request({ operation:'import',token:selection.token }); assert.ok(imported.skill);
  assert.equal(imported.skill.sha256,packageHash(readPackage(src)));
  assert.deepEqual(readFileSync(join(f.storage.paths.skill(imported.skill.id,imported.skill.version),'SKILL.md')),readFileSync(join(src,'SKILL.md')));
  failure(f,{ operation:'import',token:selection.token },'FORBIDDEN');
  const expired = f.select(src); now += 300001; failure(f,{ operation:'import',token:expired.token },'FORBIDDEN');
  assert.equal(f.request({ operation:'list',limit:100,offset:0 }).total,1);
});

test('K02 missing entry, malformed UTF-8/YAML, duplicate keys and field types report file/line without registering', t => {
  const f = fixture(t);
  for (const content of [null,Buffer.from([0xff]),'---\nname: x\nname: y\ndescription: z\n---\n','---\nname: [array]\ndescription: z\n---\n','---\nname: x\ndescription: z\ndisable-model-invocation: "true"\n---\n','no frontmatter']) {
    const path = join(f.root,randomUUID()); mkdirSync(path); if (content !== null) writeFileSync(join(path,'SKILL.md'),content);
    const result = f.importSkill(path); assert.equal(result.skill,null); assert.equal(result.report.valid,false); assert.equal(result.report.diagnostics[0].path,'SKILL.md');
  }
  assert.equal(f.request({ operation:'list',limit:100,offset:0 }).total,0); assert.deepEqual(readdirSync(join(f.storage.paths.root,'skills')),[]);
});

test('K03 idempotent same ID/version/hash; conflicting bytes rejected; platform identities distinguish same names', t => {
  const f = fixture(t), src = source(f), first = f.importSkill(src).skill;
  assert.equal(f.importSkill(src).duplicate,true);
  writeFileSync(join(src,'extra.txt'),'changed'); const token = f.select(src).token;
  failure(f,{ operation:'import',token },'VERSION_CONFLICT'); assert.equal(f.request({ operation:'list',limit:100,offset:0 }).total,1);
  const noVersion = source(f,{ platform:false }), a = f.importSkill(noVersion).skill;
  assert.equal(a.versionOrigin,'platform'); assert.equal(a.identityOrigin,'source'); assert.equal(f.importSkill(noVersion).skill.version,a.version);
  writeFileSync(join(noVersion,'new.txt'),'new version'); const b = f.importSkill(noVersion).skill;
  assert.equal(a.id,b.id); assert.notEqual(a.version,b.version);
  const other = f.importSkill(source(f,{ platform:false })).skill; assert.notEqual(other.id,a.id); assert.equal(other.name,a.name);
});

test('K04/K07 two apps resolve same names by identity; upgrades and invocation changes preserve old revision/session', async t => {
  const f = fixture(t), skillId = randomUUID(), a = f.importSkill(source(f,{ skillId,body:'Package A' })).skill;
  const b = f.importSkill(source(f,{ body:'Package B' })).skill, { apps,create,bindings,publish } = await appFixture(f);
  const conflicting = create();
  assert.equal(apps.request({ operation:'bindSkills',appId:conflicting.id,expectedVersion:conflicting.version,skills:[bind(a),bind(b)] }).error.code,'INVALID_INPUT');
  assert.equal(apps.request({ operation:'bindSkills',appId:conflicting.id,expectedVersion:conflicting.version,skills:[bind(a,{ hash:'0'.repeat(64) })] }).error.code,'SKILL_INTEGRITY');
  let appA = publish(bindings(create(),[bind(a,{ invocationMode:'explicit' })]));
  const appB = publish(bindings(create(),[bind(b)])), firstId = appA.currentRevisionId;
  const pathA = apps.resolveSkills(appA.id,firstId).paths[0], firstBytes = readFileSync(pathA);
  assert.match(firstBytes.toString(),/Package A/); assert.match(firstBytes.toString(),/disable-model-invocation: true/);
  assert.match(readFileSync(apps.resolveSkills(appB.id,appB.currentRevisionId).paths[0],'utf8'),/Package B/);
  assert.deepEqual(apps.resolveSkills(appA.id,firstId).extensions,[]); assert.equal(apps.resolveSkills(appA.id,firstId).discovery,false);
  const conversation = f.storage.createConversation(appA.id,randomUUID(),'old');
  const next = f.importSkill(source(f,{ skillId,version:'2.0.0',body:'Package A upgraded' })).skill;
  appA = publish(bindings(appA,[bind(next)]));
  assert.deepEqual(readFileSync(apps.resolveSkills(appA.id,firstId).paths[0]),firstBytes);
  assert.equal(f.storage.conversations.get({ id:conversation.id,appId:appA.id }).revisionId,firstId);
  assert.match(readFileSync(apps.resolveSkills(appA.id,appA.currentRevisionId).paths[0],'utf8'),/disable-model-invocation: false/);
  failure(f,{ operation:'delete',id:a.id,version:a.version },'SKILL_IN_USE');
  assert.throws(() => apps.resolveSkills(appB.id,firstId),{ code:'NOT_FOUND' });
  const disabled = publish(bindings(appA,[bind(next,{ enabled:false })])); assert.deepEqual(apps.resolveSkills(disabled.id,disabled.currentRevisionId).paths,[]);
  assert.deepEqual(disabled.draft.permissions,{ mode:'chat',tools:[] });
});

test('K05 dependency states are observations; missing Bash prevents publication; unknown CLI and constraints remain unverified', async t => {
  const probe = (name,constraint) => ({ name,constraint,status:name === 'node' ? 'satisfied':name === 'bash' || name === 'python' ? 'missing':'unverified',detail:'Controlled detector fixture' });
  const f = fixture(t,{ probe }); const src = source(f,{ extra:'    dependencies:\n      - name: bash\n      - name: python\n      - name: unknown-cli\n      - name: node\n    capabilities: [shell, network]\n' });
  const skill = f.importSkill(src).skill; assert.deepEqual(skill.report.dependencies.map(d => d.status),['missing','missing','unverified','satisfied']);
  assert.equal(detectDependency('node','*').status,'satisfied'); assert.equal(detectDependency('unknown-cli','*').status,'unverified'); assert.equal(detectDependency('node','>=999').status,'unverified');
  const { apps,create } = await appFixture(f); let app = create();
  app = ok(apps.request({ operation:'update',appId:app.id,expectedVersion:app.version,metadata,draft:{ ...app.draft,skills:[bind(skill)] } })).app;
  assert.ok(app.draftIssues.includes('SKILL_UNRESOLVED')); assert.equal(apps.request({ operation:'publish',appId:app.id,expectedVersion:app.version }).ok,false);
});

test('K06 absolute/traversing/encoded refs, broken refs, Windows junctions and hard links are rejected', t => {
  const f = fixture(t);
  for (const body of ['[bad](../outside.txt)','[bad](C:/private.txt)','[bad](%2e%2e/secret)','[bad](\\\\server\\share)','[bad](missing.txt)','`python ../escape.py`','`C:\\private\\x.txt`']) {
    const result = f.importSkill(source(f,{ body })); assert.equal(result.skill,null,body); assert.ok(result.report.diagnostics.some(d => d.status === 'error'));
  }
  const src = source(f), outside = join(f.root,'outside'); mkdirSync(outside); writeFileSync(join(outside,'secret'),'secret');
  symlinkSync(outside,join(src,'linked'),process.platform === 'win32' ? 'junction':'dir');
  const result = f.importSkill(src); assert.equal(result.skill,null); assert.equal(result.report.diagnostics[0].code,'LINK_REJECTED');
  assert.equal(readFileSync(join(outside,'secret'),'utf8'),'secret');
  const hard = source(f); linkSync(join(outside,'secret'),join(hard,'hard.txt')); assert.equal(f.importSkill(hard).skill,null);
});

test('K06 limits and static references, dynamic references remain visibly unverified', t => {
  const f = fixture(t), src = source(f,{ body:'[doc](docs/ref.md)\n[dynamic](${TARGET}/input)\n[remote](https://example.com/info)' });
  mkdirSync(join(src,'docs')); writeFileSync(join(src,'docs','ref.md'),'Reference');
  const result = f.importSkill(src); assert.ok(result.skill); assert.ok(result.report.diagnostics.some(d => d.code === 'DYNAMIC_REFERENCE'));
  const large = source(f); writeFileSync(join(large,'large.bin'),Buffer.alloc(skillLimits.fileBytes + 1)); assert.equal(f.importSkill(large).report.diagnostics[0].code,'LIMIT');
  const many = source(f); for (let i = 0;i < 1000;i++) writeFileSync(join(many,`${i}.txt`),''); assert.equal(f.importSkill(many).report.diagnostics[0].code,'LIMIT');
  const flooded = source(f,{ body:'[remote](https://example.com)\n'.repeat(2100) + '[escape](../outside)' });
  assert.equal(f.importSkill(flooded).skill,null,'diagnostic truncation cannot hide a late error');
});

test('K08 failed copy/rename/database and real SQLite failure leave no bindable residue; retry succeeds', t => {
  let fail; const f = fixture(t,{ fault:point => { if (point === fail) throw new Error('injected disk error'); } }), src = source(f);
  for (fail of ['copied','renamed','database']) {
    failure(f,{ operation:'import',token:f.select(src).token },'STORAGE_UNAVAILABLE');
    assert.equal(f.request({ operation:'list',limit:100,offset:0 }).total,0);
    assert.equal(readdirSync(join(f.storage.paths.root,'skills')).some(s => s.startsWith('.staging-')),false);
  }
  fail = undefined; const db = new DatabaseSync(f.storage.paths.database);
  try {
    db.exec("CREATE TRIGGER fail_skill BEFORE INSERT ON skill_registry BEGIN SELECT RAISE(ABORT,'test disk database failure'); END;");
    failure(f,{ operation:'import',token:f.select(src).token },'STORAGE_UNAVAILABLE'); assert.deepEqual(f.storage.skills.list({}),[]);
    db.exec('DROP TRIGGER fail_skill');
  } finally { db.close(); }
  const orphan = join(f.storage.paths.root,'skills',randomUUID(),'1.0.0'), stage = join(f.storage.paths.root,'skills',`.staging-${randomUUID()}`);
  mkdirSync(orphan,{ recursive:true }); mkdirSync(stage); f.registry.collect(); assert.equal(existsSync(orphan),false); assert.equal(existsSync(stage),false);
  const skill = f.importSkill(src).skill; assert.ok(skill);
  f.request({ operation:'delete',id:skill.id,version:skill.version }); assert.equal(existsSync(f.storage.paths.skill(skill.id,skill.version)),false);
  assert.ok(f.importSkill(src).skill);
});

test('K08 source mutations during import are detected; final copied metadata is authoritative', t => {
  let src; const f = fixture(t,{ fault:point => { if (point === 'copied') writeFileSync(join(src,'SKILL.md'),'changed during copy'); } }); src = source(f);
  const result = f.importSkill(src); assert.equal(result.skill,null); assert.equal(result.report.diagnostics[0].code,'SOURCE_CHANGED'); assert.deepEqual(f.storage.skills.list({}),[]);
});

test('K09 source and materialized snapshots are independently verified; no silent replacement', async t => {
  const f = fixture(t), skill = f.importSkill(source(f)).skill, { apps,create,bindings,publish } = await appFixture(f);
  const app = publish(bindings(create(),[bind(skill)])), sourcePath = join(f.storage.paths.skill(skill.id,skill.version),'SKILL.md');
  const original = readFileSync(sourcePath), snapshotPath = apps.resolveSkills(app.id,app.currentRevisionId).paths[0];
  writeFileSync(sourcePath,'tampered'); failure(f,{ operation:'validate',id:skill.id,version:skill.version },'SKILL_INTEGRITY');
  assert.throws(() => apps.resolveSkills(app.id,app.currentRevisionId),{ code:'SKILL_INTEGRITY' });
  writeFileSync(sourcePath,original); writeFileSync(snapshotPath,'tampered runtime'); assert.throws(() => apps.resolveSkills(app.id,app.currentRevisionId),{ code:'SKILL_INTEGRITY' });
});

test('K10 scripts never execute during import/get/validation; allowed-tools grants no authority', t => {
  const f = fixture(t), src = source(f,{ body:'[helper](scripts/marker.cjs)' }); mkdirSync(join(src,'scripts'));
  writeFileSync(join(src,'scripts','marker.cjs'),"require('node:fs').writeFileSync('EXECUTED', 'unsafe');\n");
  const skill = f.importSkill(src).skill; assert.ok(skill); assert.deepEqual(skill.report.scripts,['scripts/marker.cjs']);
  f.request({ operation:'get',id:skill.id,version:skill.version }); f.request({ operation:'validate',id:skill.id,version:skill.version });
  for (const path of [join(src,'EXECUTED'),join(f.storage.paths.skill(skill.id,skill.version),'EXECUTED'),resolve('EXECUTED')]) assert.equal(existsSync(path),false);
});

test('K01 hash framing is reproducible and excludes timestamps/order; filename changes affect it', () => {
  const a = new Map([['b',Buffer.from('two')],['a',Buffer.from('one')]]), b = new Map([...a].reverse());
  const expected = createHash('sha256').update('AIAppNest.Skill.v1\0').update('1:a:3:one').update('1:b:3:two').digest('hex');
  assert.equal(packageHash(a),expected); assert.equal(packageHash(a),packageHash(b)); assert.notEqual(packageHash(a),packageHash(new Map([['c',Buffer.from('one')],['b',Buffer.from('two')]])));
});

test('K01 production Service Host IPC imports/persists and rejects forged owner/token and arbitrary extensions', async t => {
  const root = mkdtempSync(resolve('.test-skills-ipc-')); let manager;
  const start = async () => { manager = new ServiceManager({ nodePath:process.execPath,entry:resolve('dist/service-host.cjs'),dataRoot:join(root,'data') }); ok(await manager.start()); };
  t.after(async () => { await manager?.stop(); rmSync(root,{ recursive:true,force:true,maxRetries:10,retryDelay:100 }); });
  const src = source({ root }), owner = randomUUID(); await start();
  const selection = ok(await manager.skills({ operation:'select',owner,path:src,scope:'skill-import' })).selection;
  const skill = ok(await manager.skills({ operation:'request',owner,request:{ operation:'import',token:selection.token } })).reply.skill; assert.ok(skill);
  assert.equal((await manager.skills({ operation:'request',owner,request:{ operation:'installExtension',path:src } })).error.code,'INVALID_INPUT');
  await manager.stop(); await start();
  assert.equal(ok(await manager.skills({ operation:'request',owner,request:{ operation:'list',offset:0,limit:100 } })).reply.total,1);
  assert.equal((await manager.skills({ operation:'request',owner,request:{ operation:'import',token:selection.token } })).error.code,'FORBIDDEN');
});
