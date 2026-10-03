import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { probeCodeSchema, type ProbeCode } from '@aiappnest/contracts';
import type { ProviderRuntime } from './runtime';

export function testRuntime(runtime: ProviderRuntime, workerPath = join(__dirname, 'provider-probe.cjs')): Promise<ProbeCode> {
  return new Promise(resolve => {
    let settled = false;
    const worker = new Worker(workerPath, { workerData: runtime, env: runtime.env, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64 } });
    // Never forward SDK output, error objects, or response bodies into host diagnostics.
    worker.stdout.resume(); worker.stderr.resume();
    const finish = (code: ProbeCode) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      void worker.terminate().then(() => resolve(code), () => resolve(code));
    };
    const timer = setTimeout(() => finish('TIMEOUT'), runtime.timeoutMs);
    worker.once('message', raw => {
      const result = probeCodeSchema.safeParse(raw);
      finish(result.success ? result.data : 'PROTOCOL_ERROR');
    });
    worker.once('error', () => finish('PROTOCOL_ERROR'));
    worker.once('exit', () => finish('PROTOCOL_ERROR'));
  });
}
