// Reproducible, metadata-only evidence bundle. Real-model results are recorded separately.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeEnv, spikeRoot } from './native.mjs';
import { environment } from './environment.mjs';
import { nativeProbe } from './native-probe.mjs';
import { prepare } from './config.mjs';
import { Worker } from './worker.mjs';
const repo = resolve(spikeRoot, '../..');
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', join(spikeRoot, 'test/protocol.test.mjs'), join(spikeRoot, 'test/windows.test.mjs')], {
  shell: false, windowsHide: true, env: nativeEnv(), encoding: 'utf8', timeout: 120000,
});
const evidence = { date: new Date().toISOString().slice(0, 10), environment: environment(),
  packageLockSha256: createHash('sha256').update(await readFile(join(repo, 'package-lock.json'))).digest('hex'),
  kind: 'real-pi-deterministic-provider-not-real-model', exitCode: result.status,
  tests: (result.stdout ?? '').split(/\r?\n/).filter(line => /^(ok |not ok |# (tests|pass|fail|skipped|cancelled|todo) )/.test(line)),
  native: await nativeProbe(), traces: {}, gate: 'BLOCKED_PENDING_REAL_MODEL_AND_NATIVE_ACCEPTANCE' };
const root = await mkdtemp(join(spikeRoot, '.runs/evidence-'));
const config = await prepare(root, 'A'); const w = await Worker.start(config, { fixture: true });
try {
  for (const [name, prompt] of [['success', 'hello'], ['handled', '__handled__'], ['modelFailure', 'model-error'], ['toolDenial', 'tool:{"name":"denied_write","args":{}}']]) {
    const start = w.audit.length; const run = await w.run(prompt);
    evidence.traces[name] = { status: run.status, events: w.audit.slice(start) };
  }
} finally { await w.close(); }
const path = resolve(process.argv[2] ?? join(spikeRoot, '.runs/regression-evidence.json'));
await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ regressionExitCode: result.status, native: evidence.native, gate: evidence.gate }));
if (result.status !== 0) process.exitCode = 1;
