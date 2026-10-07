import { hostInputSchema, publicError, type HostOutput } from '@aiappnest/contracts';
import { SERVICE_NODE_VERSION, SERVICE_PROTOCOL_VERSION } from '@aiappnest/domain';
import { Storage, resolveDataRoot } from '@aiappnest/storage';
import { join } from 'node:path';
import { CredentialService } from './credentials';
import { ProviderService } from './providers';
import { AppService } from './apps';
import { SkillRegistry } from './skills';
import { PolicyService } from '../../../packages/policy/src/index';
import { readEngineRuntime } from '../../../packages/pi-adapter/src/index';
import { RunScheduler } from './runs';
import { readRunSettings } from './run-settings';

// Only the owning Main process can access this inherited IPC pipe. No network listener.
if (!process.send || process.versions.node !== SERVICE_NODE_VERSION) process.exit(1);
let ready = false;
let storage: Storage | undefined;
let providers: ProviderService | undefined;
let apps: AppService | undefined;
let skills: SkillRegistry | undefined;
let policy: PolicyService | undefined;
let runs: RunScheduler | undefined;
let closing: Promise<void> | undefined;
const close = () => { policy?.close(); policy = undefined; storage?.close(); storage = undefined; };
const shutdown = () => closing ??= (async () => {
  ready = false;
  try { await runs?.close(); } catch { process.exitCode = 1; }
  finally { close(); if (process.connected) process.disconnect(); }
})();
const handshakeDeadline = setTimeout(() => process.exit(1), 5000);
const send = (message: HostOutput) => {
  if (process.connected) process.send!(message, undefined, undefined, (error) => { if (error) process.exit(1); });
};
process.on('disconnect', () => { void shutdown().finally(() => process.exit(process.exitCode ?? 0)); });
process.on('exit', close);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void shutdown().finally(() => process.exit(0)); });
process.on('message', (raw: unknown) => {
  const parsed = hostInputSchema.safeParse(raw);
  if (!parsed.success) {
    send({ kind: 'fatal', error: publicError('PROTOCOL_ERROR') });
    process.exitCode = 1;
    process.disconnect();
    return;
  }
  const message = parsed.data;
  if (message.kind === 'shutdown') { clearTimeout(handshakeDeadline); void shutdown(); return; }
  if (message.kind === 'hello' && !ready) {
    clearTimeout(handshakeDeadline);
    try {
      storage = new Storage(resolveDataRoot(process.env.AIAPPNEST_DATA_ROOT));
      providers = new ProviderService(storage, new CredentialService(storage.paths, join(__dirname, 'credential-host.exe')));
      skills = new SkillRegistry(storage);
      apps = new AppService(storage, providers, undefined, skills);
      policy = new PolicyService(storage, (appId, revisionId) => apps!.readRevision(appId, revisionId));
      runs = new RunScheduler({ storage, apps, providers, policy }, readEngineRuntime(__dirname), readRunSettings(storage));
    }
    catch {
      send({ kind: 'fatal', error: publicError('STORAGE_UNAVAILABLE') });
      process.exitCode = 1;
      process.disconnect();
      return;
    }
    ready = true;
    send({ kind: 'ready', nonce: message.nonce, version: SERVICE_PROTOCOL_VERSION, pid: process.pid, nodeVersion: process.versions.node });
  } else if (message.kind === 'ping' && ready) {
    send({ kind: 'response', id: message.id, result: { ok: true, value: { text: message.input.text, pid: process.pid, nodeVersion: process.versions.node } } });
  } else if (message.kind === 'providers' && ready) {
    void providers!.request(message.input).then(result => send({ kind: 'providers-response', id: message.id, result }));
  } else if (message.kind === 'apps' && ready) {
    send({ kind: 'apps-response', id: message.id, result: apps!.request(message.input) });
  } else if (message.kind === 'skills' && ready) {
    send({ kind: 'skills-response', id: message.id, result: skills!.request(message.input) });
  } else if (message.kind === 'policy' && ready) {
    send({ kind: 'policy-response', id: message.id, result: policy!.request(message.input) });
  } else if (message.kind === 'runs' && ready) {
    send({ kind: 'runs-response', id: message.id, result: runs!.request(message.input) });
  } else {
    send({ kind: 'fatal', error: publicError('PROTOCOL_ERROR') });
    process.disconnect();
  }
});
