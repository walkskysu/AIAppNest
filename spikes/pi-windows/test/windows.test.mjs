import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from '../src/worker.mjs';
import { prepare, workerEnv, launchArgs, validateSession } from '../src/config.mjs';
import { spikeRoot, nativeHost, nativeEnv, spawnJob, saveCredential, readCredential } from '../src/native.mjs';

const windows = process.platform === 'win32';
async function root(name) { const base = join(spikeRoot, '.runs'); await mkdir(base, { recursive: true }); return mkdtemp(join(base, `${name}-`)); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function eventually(fn, timeout = 10000) { const end = Date.now() + timeout; while (!await fn()) { if (Date.now() > end) throw new Error('Condition timeout'); await delay(25); } }
async function inspect(w) {
  const from = w.events.length; await w.command('prompt', { message: '/spike-inspect' });
  return JSON.parse(w.events.slice(from).find(e => e.type === 'extension_ui_request').message);
}
const tool = (name, args = {}) => `tool:${JSON.stringify({ name, args })}`;
const text = r => JSON.stringify(r.messages);

test('Windows runtime lock and CRT argument round trip', { skip: !windows }, async () => {
  assert.equal(process.version, 'v24.19.0'); nativeHost();
  const args = ['中文', 'with space', '中文 空格', 'quote"value', 'trailing space \\', ''];
  const child = spawnJob(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => output += b);
  await new Promise(resolve => child.once('close', resolve)); assert.deepEqual(JSON.parse(output), args);
});

for (const name of ['中文', 'with space', '中文 空格']) test(`V02/V07 exact save and restore: ${name}`, { skip: !windows }, async t => {
  const c = await prepare(await root(name), 'A');
  const w = await Worker.start(c, { fixture: true }); t.after(() => w.close());
  assert.equal((await w.run('context-marker-A')).status, 'succeeded');
  // Completed read tool must not be replayed by restoration.
  await w.run(tool('controlled_read', { path: 'allowed.txt' }));
  const before = (await w.command('get_messages')).data.messages;
  const file = w.sessionFile; await access(file); await w.close();
  const restored = await Worker.start(c, { fixture: true, sessionFile: file }); t.after(() => restored.close());
  assert.deepEqual((await restored.command('get_messages')).data.messages, before);
  assert.ok(!restored.events.some(e => e.type === 'agent_start' || e.type.startsWith('tool_execution')));
  assert.ok(text(await restored.run('recall')).includes('context-marker-A'));
});

test('V03/V04/V11/V12 concurrent apps, same-name skill, resources, environment', { skip: !windows }, async t => {
  const base = await root('isolation');
  const a = await prepare(join(base, 'A'), 'A'); const b = await prepare(join(base, 'B'), 'B');
  // Poison both the managed cwd discovery locations and the user workspace.
  for (const dir of [a.cwd, a.workspace]) {
    await mkdir(join(dir, '.pi/extensions'), { recursive: true });
    await mkdir(join(dir, '.pi/skills/rogue'), { recursive: true });
    await writeFile(join(dir, 'AGENTS.md'), 'UNAPPROVED_CANARY');
    await writeFile(join(dir, 'CLAUDE.md'), 'UNAPPROVED_CANARY');
    await writeFile(join(dir, '.pi/SYSTEM.md'), 'UNAPPROVED_CANARY');
    await writeFile(join(dir, '.pi/APPEND_SYSTEM.md'), 'UNAPPROVED_CANARY');
    await writeFile(join(dir, '.pi/skills/rogue/SKILL.md'), '---\nname: rogue\ndescription: UNAPPROVED_CANARY\n---\nUNAPPROVED_CANARY');
    await writeFile(join(dir, '.pi/extensions/rogue.ts'), 'throw new Error("UNAPPROVED_CANARY");');
  }
  await writeFile(join(a.workspace, '.pi/settings.json'), JSON.stringify({ defaultProvider: 'poison', packages: ['UNAPPROVED_CANARY'] }));
  const globalBefore = { ...process.env };
  const env = workerEnv(a, { OPENAI_API_KEY: 'non-secret-A' }, { ...process.env, UNRELATED_API_KEY: 'non-secret-other', NODE_OPTIONS: '--bad' });
  assert.equal(env.UNRELATED_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  const [wa, wb] = await Promise.all([Worker.start(a, { fixture: true, credentials: { OPENAI_API_KEY: 'non-secret-A' } }), Worker.start(b, { fixture: true })]);
  t.after(() => Promise.all([wa.close(), wb.close()]));
  const [ia, ib] = await Promise.all([inspect(wa), inspect(wb)]);
  assert.equal(ia.app, 'A'); assert.equal(ib.app, 'B'); assert.ok(ia.keyPresent); assert.ok(!ib.keyPresent);
  assert.ok(!ia.poisoned); assert.ok(ia.rolePresent); assert.ok(ib.rolePresent);
  const commands = (await wa.command('get_commands')).data.commands;
  assert.ok(!commands.some(c => c.name.includes('rogue')));
  const [ra, rb] = await Promise.all([wa.run('/skill:identity'), wb.run('/skill:identity')]);
  assert.ok(text(ra).includes('SKILL_A')); assert.ok(!text(ra).includes('SKILL_B'));
  assert.ok(text(rb).includes('SKILL_B')); assert.ok(!text(rb).includes('SKILL_A'));
  assert.notEqual(wa.sessionFile, wb.sessionFile); assert.deepEqual({ ...process.env }, globalBefore);
  await assert.rejects(validateSession(b, wa.sessionFile), /outside/);
  await writeFile(join(a.cwd, '.pi/settings.json'), '{}');
  await assert.rejects(launchArgs(a, { fixture: true }), /settings forbidden/);
});

test('V06 handled, model failure, tool failure, successful run and error exit', { skip: !windows }, async t => {
  const c = await prepare(await root('lifecycle'), 'A'); const w = await Worker.start(c, { fixture: true }); t.after(() => w.close());
  const handled = await w.run('__handled__'); assert.equal(handled.status, 'handled');
  assert.ok(!handled.events.some(e => e.type === 'agent_start'));
  assert.equal((await w.run('model-error')).status, 'failed');
  assert.equal((await w.run(tool('controlled_read', { path: 'missing.txt' }))).status, 'failed');
  assert.equal((await w.run('hello')).status, 'succeeded');
  const pending = w.run(tool('test_wait', { stubborn: true })); const rejected = assert.rejects(pending, /exited/);
  await eventually(() => existsSync(join(c.workspace, 'wait.pid'))); await w.close(true); await rejected;
  assert.ok(!alive(Number(await readFile(join(c.workspace, 'wait.pid'), 'utf8'))));
});

test('V08 bad, missing, relative, directory and cross-session paths fail before spawn', { skip: !windows }, async () => {
  const c = await prepare(await root('bad-session'), 'A');
  for (const file of ['guess', join(c.sessions, 'absent.jsonl'), c.sessions]) await assert.rejects(launchArgs(c, { fixture: true, sessionFile: file }));
  const invalid = join(c.sessions, 'invalid.jsonl'); await writeFile(invalid, '');
  await assert.rejects(launchArgs(c, { fixture: true, sessionFile: invalid }), /header/);
});

test('V08 exclusively locked session fails instead of silently creating another', { skip: !windows }, async t => {
  const c = await prepare(await root('unreadable'), 'A'); const w = await Worker.start(c, { fixture: true }); t.after(() => w.close());
  await w.run('save'); const sessionFile = w.sessionFile; await w.close();
  const lock = spawn(nativeHost(), ['lock', sessionFile], { shell: false, windowsHide: true, env: nativeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => lock.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('File lock helper timeout')), 10000);
    lock.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    lock.once('error', error => { clearTimeout(timer); reject(error); });
    lock.once('exit', () => { clearTimeout(timer); reject(new Error('File lock helper exited')); });
  });
  await assert.rejects(Worker.start(c, { fixture: true, sessionFile })); lock.stdin.end('\n');
});

test('V10 tool entry denies before side effects; traversal, junction and built-in bypass', { skip: !windows }, async t => {
  const c = await prepare(await root('policy'), 'A'); const w = await Worker.start(c, { fixture: true }); t.after(() => w.close());
  assert.deepEqual((await inspect(w)).tools.sort(), ['controlled_read', 'denied_write', 'test_wait']);
  assert.equal((await w.run(tool('denied_write'))).status, 'failed'); assert.ok(!existsSync(join(c.workspace, 'MUST_NOT_EXIST')));
  assert.equal((await w.run(tool('controlled_read', { path: 'allowed.txt' }))).status, 'succeeded');
  await writeFile(join(c.root, 'outside.txt'), 'outside');
  assert.equal((await w.run(tool('controlled_read', { path: '../outside.txt' }))).status, 'failed');
  await symlink(c.agent, join(c.workspace, 'junction'), 'junction');
  assert.equal((await w.run(tool('controlled_read', { path: 'junction/settings.json' }))).status, 'failed');
  for (const name of ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']) {
    assert.equal((await w.run(tool(name, { path: 'MUST_NOT_EXIST', content: 'bypass', command: 'echo forbidden' }))).status, 'failed');
  }
  const chat = await prepare(await root('chat'), 'B', 'chat'); const wc = await Worker.start(chat, { fixture: true }); t.after(() => wc.close());
  assert.deepEqual((await inspect(wc)).tools, []);
  assert.equal((await wc.run(tool('controlled_read', { path: 'allowed.txt' }))).status, 'failed');
});

for (const stubborn of [false, true]) test(`V09 abort ${stubborn ? 'timeout force' : 'cooperative'} clears actual tool child`, { skip: !windows }, async t => {
  const c = await prepare(await root('cancel'), 'A'); const w = await Worker.start(c, { fixture: true }); t.after(() => w.close(true));
  const run = w.run(tool('test_wait', { stubborn })).then(result => result.status, () => 'interrupted');
  await eventually(() => existsSync(join(c.workspace, 'wait.pid')));
  const pid = Number(await readFile(join(c.workspace, 'wait.pid'), 'utf8')); assert.ok(alive(pid));
  assert.equal(await w.cancel(500), stubborn ? 'forced' : 'cooperative');
  assert.equal(await run, stubborn ? 'interrupted' : 'cancelled');
  await eventually(() => !alive(pid));
});

test('V09 host crash kills only its Job descendants; unrelated process survives', { skip: !windows }, async t => {
  const dir = await root('host-crash'); const pidFile = join(dir, 'pids.json');
  const control = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { shell: false, windowsHide: true, env: nativeEnv(), stdio: 'ignore' }); t.after(() => control.kill());
  const host = spawn(process.execPath, [join(spikeRoot, 'fixtures/crash-host.mjs'), pidFile], { shell: false, windowsHide: true, env: nativeEnv(), stdio: 'ignore' }); t.after(() => host.kill());
  await eventually(() => existsSync(pidFile)); const pids = JSON.parse(await readFile(pidFile, 'utf8'));
  assert.ok(pids.every(alive)); host.kill();
  await eventually(() => pids.every(pid => !alive(pid))); assert.ok(alive(control.pid));
});

test('V09 normal shutdown escalates for a stubborn tool and clears descendants', { skip: !windows }, async t => {
  const c = await prepare(await root('shutdown'), 'A'); const w = await Worker.start(c, { fixture: true }); t.after(() => w.close(true));
  const run = w.run(tool('test_wait', { stubborn: true })).catch(() => 'interrupted');
  await eventually(() => existsSync(join(c.workspace, 'wait.pid')));
  const pid = Number(await readFile(join(c.workspace, 'wait.pid'), 'utf8'));
  await w.close(); await run; await eventually(() => !alive(pid));
});

test('V13 DPAPI ciphertext persistence (environment prerequisite)', { skip: !windows }, async t => {
  const dir = await root('native'); const secret = 'non-sensitive-DPAPI-marker-中文'; const file = join(dir, 'credential.bin');
  try { saveCredential(file, secret); }
  catch (error) {
    // The restricted automation token cannot access CurrentUser DPAPI. Do not substitute encryption.
    // The standalone native acceptance probe still exits nonzero and reports BLOCKED.
    if (error.message.includes('CryptographicException:80131430')) { t.skip('BLOCKED: CurrentUser DPAPI 0x80131430; run npm run spike:native with a normal Windows user token'); return; }
    throw error;
  }
  assert.equal(readCredential(file), secret); assert.ok(!(await readFile(file)).includes(Buffer.from(secret)));
});
test('V13 Node SQLite basic read/write', { skip: !windows }, async () => {
  const dir = await root('sqlite');
  const db = new DatabaseSync(join(dir, 'test.db'));
  try { db.exec('CREATE TABLE proof (value TEXT)'); db.prepare('INSERT INTO proof VALUES (?)').run('中文 SQLite'); assert.equal(db.prepare('SELECT value FROM proof').get().value, '中文 SQLite'); }
  finally { db.close(); }
});
