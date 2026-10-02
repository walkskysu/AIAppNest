// Opt-in real-model acceptance. Never prints provider payloads, keys, paths, or error messages.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { prepare, validateSession } from './config.mjs';
import { Worker } from './worker.mjs';
import { spikeRoot, nativeEnv, saveCredential, readCredential } from './native.mjs';
import { nativeProbe } from './native-probe.mjs';
import { environment } from './environment.mjs';

const ids = Array.from({ length: 13 }, (_, i) => `V${String(i + 1).padStart(2, '0')}`);
const report = { environment: environment(), kind: 'real-model-acceptance', results: Object.fromEntries(ids.map(id => [id, 'NOT_RUN'])), traces: [], gate: 'BLOCKED' };
await mkdir(join(spikeRoot, '.runs'), { recursive: true });
const root = await mkdtemp(join(spikeRoot, '.runs/live-'));
const provider = process.env.SPIKE_PROVIDER, model = process.env.SPIKE_MODEL;
const keyName = process.env.SPIKE_API_KEY_ENV;
let secret = keyName && /^[A-Z][A-Z0-9_]*_API_KEY$/.test(keyName) ? process.env[keyName] : undefined;
const workers = [];
async function start(config, options = {}) {
  const w = await Worker.start(config, { provider, model, credentials: { [keyName]: secret }, ...options });
  workers.push(w); return w;
}
async function record(ids, fn) {
  try { await fn(); for (const id of ids) report.results[id] = 'PASS'; }
  catch { for (const id of ids) report.results[id] = 'FAIL'; }
}
const answer = result => result.messages.filter(m => m.role === 'assistant').at(-1)?.content.filter(b => b.type === 'text').map(b => b.text).join('') ?? '';
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate, timeout = 60000) {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= end) throw new Error('timeout'); await delay(25); }
}
async function inspect(worker) {
  const from = worker.events.length; await worker.command('prompt', { message: '/spike-inspect' });
  return JSON.parse(worker.events.slice(from).find(e => e.type === 'extension_ui_request').message);
}
async function scanNoKey(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scanNoKey(path);
    else if ((await readFile(path)).includes(Buffer.from(secret))) throw new Error('credential leak');
  }
}
try {
  const native = await nativeProbe(); report.native = native;
  report.results.V13 = native.dpapi === 'PASS' && native.sqlite === 'PASS' ? 'PASS' : 'BLOCKED';
  if (!provider || !model || !secret) report.prerequisite = 'MISSING_EXPLICIT_MODEL_CREDENTIAL';
  else {
    report.model = { provider, id: model }; // Explicit non-sensitive configuration, never the key.
    // Regression tests are isolated from the live credential and their raw output is not exported.
    const regression = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(spikeRoot, 'test/protocol.test.mjs'), join(spikeRoot, 'test/windows.test.mjs')], { env: nativeEnv(), shell: false, windowsHide: true, timeout: 120000 });
    report.regression = regression.status === 0 ? 'PASS' : 'FAIL';
    for (const id of ['V05', 'V06', 'V08']) report.results[id] = report.regression;
    if (native.dpapi === 'PASS') {
      const path = join(root, 'credential.bin'); saveCredential(path, secret); secret = readCredential(path);
    }
    await record(['V01', 'V02', 'V07'], async () => {
      for (const name of ['中文', 'with space', '中文 空格']) {
        const config = await prepare(join(root, name), 'A'); let w = await start(config);
        const marker = `CONTEXT_${randomUUID()}`;
        const initial = await w.run(`Remember this test marker: ${marker}. Reply exactly ACK.`, 90000);
        assert.equal(initial.status, 'succeeded'); assert.match(answer(initial), /ACK/);
        const read = await w.run('Call controlled_read on allowed.txt once and report the content.', 90000);
        assert.equal(read.status, 'succeeded');
        assert.ok(read.events.some(e => e.type === 'tool_execution_end' && e.toolName === 'controlled_read' && !e.isError));
        const before = (await w.command('get_messages')).data.messages;
        const sessionFile = w.sessionFile;
        // Precise mapping is private runtime data, not a public report.
        await writeFile(join(config.root, 'session-map.json'), JSON.stringify({ sessionFile }));
        await w.close(); w = await start(config, { sessionFile });
        assert.deepEqual((await w.command('get_messages')).data.messages, before);
        assert.ok(!w.events.some(e => e.type === 'agent_start' || e.type.startsWith('tool_execution')));
        const recalled = await w.run('What exact test marker did I ask you to remember? Reply only that marker.', 90000);
        assert.equal(recalled.status, 'succeeded'); assert.ok(answer(recalled).includes(marker));
        await w.close();
      }
    });
    await record(['V03', 'V04', 'V11', 'V12'], async () => {
      const a = await prepare(join(root, 'app-A'), 'A'); const b = await prepare(join(root, 'app-B'), 'B');
      for (const dir of [a.workspace, a.cwd]) {
        await mkdir(join(dir, '.pi/skills/rogue'), { recursive: true }); await mkdir(join(dir, '.pi/extensions'), { recursive: true });
        await writeFile(join(dir, 'AGENTS.md'), 'UNAPPROVED_CANARY');
        await writeFile(join(dir, '.pi/skills/rogue/SKILL.md'), '---\nname: rogue\ndescription: UNAPPROVED_CANARY\n---\nUNAPPROVED_CANARY');
        await writeFile(join(dir, '.pi/extensions/rogue.ts'), 'throw new Error("UNAPPROVED_CANARY");');
      }
      const [wa, wb] = await Promise.all([start(a), start(b)]);
      const [ia, ib] = await Promise.all([inspect(wa), inspect(wb)]);
      assert.ok(!ia.poisoned && !ib.poisoned); assert.ok(ia.rolePresent && ib.rolePresent);
      const [ra, rb] = await Promise.all([wa.run('/skill:identity', 90000), wb.run('/skill:identity', 90000)]);
      assert.equal(ra.status, 'succeeded'); assert.equal(rb.status, 'succeeded');
      assert.match(answer(ra), /SKILL_A/); assert.match(answer(rb), /SKILL_B/);
      const marker = `PRIVATE_${randomUUID()}`;
      assert.equal((await wa.run(`Remember ${marker}; reply ACK.`, 90000)).status, 'succeeded');
      assert.ok(!JSON.stringify((await wb.command('get_messages')).data.messages).includes(marker));
      await assert.rejects(validateSession(b, wa.sessionFile));
      // Third worker has no credential, while A/B each get exactly the chosen provider key.
      const observer = await start(await prepare(join(root, 'no-key'), 'C'), { credentials: {} });
      assert.equal((await inspect(observer)).keyCount, 0); assert.equal(ia.keyCount, 1); assert.equal(ib.keyCount, 1);
      for (const w of [wa, wb, observer]) await w.close(); await scanNoKey(root);
    });
    await record(['V10'], async () => {
      const c = await prepare(join(root, 'policy'), 'A'); const w = await start(c);
      assert.deepEqual((await inspect(w)).tools.sort(), ['controlled_read', 'denied_write', 'test_wait']);
      const denied = await w.run('This is a harmless permission test. Call denied_write exactly once. Do not substitute another tool.', 90000);
      assert.equal(denied.status, 'failed'); assert.ok(denied.events.some(e => e.type === 'tool_execution_end' && e.toolName === 'denied_write' && e.isError));
      assert.ok(!existsSync(join(c.workspace, 'MUST_NOT_EXIST')));
      await writeFile(join(c.root, 'outside.txt'), 'outside');
      const outside = await w.run('Call controlled_read with path ../outside.txt exactly once to test permission refusal.', 90000);
      assert.ok(outside.events.some(e => e.type === 'tool_execution_end' && e.toolName === 'controlled_read' && e.isError));
      await w.close();
      const wc = await start(await prepare(join(root, 'chat'), 'B', 'chat'));
      assert.deepEqual((await inspect(wc)).tools, []); await wc.close();
    });
    await record(['V09'], async () => {
      for (const stubborn of [false, true]) {
        const c = await prepare(join(root, `cancel-${stubborn}`), 'A'); const w = await start(c);
        const pending = w.run(`Call test_wait with stubborn=${stubborn} now. This harmless process waits until the host cancels it.`, 90000).then(r => r.status, () => 'interrupted');
        try {
          await until(() => existsSync(join(c.workspace, 'wait.pid')));
          const pid = Number(await readFile(join(c.workspace, 'wait.pid'), 'utf8')); assert.ok(alive(pid));
          assert.equal(await w.cancel(1500), stubborn ? 'forced' : 'cooperative');
          assert.equal(await pending, stubborn ? 'interrupted' : 'cancelled'); await until(() => !alive(pid), 5000);
        } finally { await w.close(true); await pending; }
      }
    });
  }
} catch { report.prerequisite = 'ACCEPTANCE_SETUP_FAILED'; }
finally {
  for (const w of workers) {
    await w.close();
    report.traces.push({ app: w.config.app, directory: relative(root, w.config.root), stderrBytes: w.stderrBytes, events: w.audit });
  }
  if (secret) { try { await scanNoKey(root); } catch { report.results.V12 = 'FAIL'; } }
  report.gate = ids.every(id => report.results[id] === 'PASS') && report.regression === 'PASS' ? 'PASS' : 'BLOCKED';
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ gate: report.gate, results: report.results, prerequisite: report.prerequisite }));
  if (report.gate !== 'PASS') process.exitCode = 2;
}
