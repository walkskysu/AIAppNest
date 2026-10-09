import { dataHostRequestSchema, type DataHostRequest, type DataRequest, type DataReply } from '@aiappnest/contracts';
import { activeTimeout } from '../../../packages/domain/src/active-time';
import { memoryRequestSchema, type MemoryRequest, type MemoryReply } from '@aiappnest/contracts';
import { fileHostRequestSchema, type FileHostRequest, type FileHostReply } from '@aiappnest/contracts';
import { chatRequestSchema, type ChatRequest, type ChatReply } from '@aiappnest/contracts';
import { runRequestSchema, type RunRequest, type RunReply } from '@aiappnest/contracts';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostOutputSchema, pingInputSchema, publicError, type ErrorCode, type HostInput, type PingOutput, type Result, type ServiceStatus } from '@aiappnest/contracts';
import { SERVICE_NODE_VERSION, SERVICE_PROTOCOL_VERSION } from '@aiappnest/domain';
import { providerRequestSchema, type ProviderReply, type ProviderRequest } from '@aiappnest/contracts';
import { appRequestSchema, type AppReply, type AppRequest } from '@aiappnest/contracts';
import { skillHostRequestSchema, type SkillHostReply, type SkillHostRequest } from '@aiappnest/contracts';
import { policyHostRequestSchema, type PolicyHostReply, type PolicyHostRequest } from '@aiappnest/contracts';

type Pending = { kind: 'data-response' | 'memories-response' | 'files-response' | 'response' | 'providers-response' | 'apps-response' | 'skills-response' | 'policy-response' | 'runs-response' | 'chat-response'; operation?: DataRequest['operation'] | DataHostRequest['operation'] | MemoryRequest['operation'] | FileHostRequest['operation'] | ProviderRequest['operation'] | AppRequest['operation'] | SkillHostRequest['operation'] | PolicyHostRequest['operation'] | RunRequest['operation'] | ChatRequest['operation']; resolve: (result: Result<DataReply | MemoryReply | FileHostReply | PingOutput | ProviderReply | AppReply | SkillHostReply | PolicyHostReply | RunReply | ChatReply>) => void; timer: NodeJS.Timeout };
export function serviceEnvironment(dataRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (dataRoot !== undefined) env.AIAPPNEST_DATA_ROOT = dataRoot;
  return env;
}

export class ServiceManager extends EventEmitter {
  private child?: ChildProcess;
  private pending = new Map<string, Pending>();
  private status: ServiceStatus = { phase: 'stopped', revision: 0, pid: null, error: null };
  private starting?: Promise<Result<ServiceStatus>>;
  private stopping?: Promise<void>;
  private closing = false;
  private finishStart?: (result: Result<ServiceStatus>) => void;
  private startTimer?: NodeJS.Timeout;
  private nonce = '';
  constructor(private readonly options: { nodePath: string; entry: string; dataRoot?: string; startupMs?: number; requestMs?: number; shutdownMs?: number }) { super(); }
  snapshot(): ServiceStatus { return structuredClone(this.status); }
  private transition(phase: ServiceStatus['phase'], code?: ErrorCode) {
    this.status = { phase, revision: this.status.revision + 1, pid: phase === 'ready' ? this.child?.pid ?? null : null, error: code ? publicError(code) : null };
    this.emit('status', this.snapshot());
  }
  private settleStart(result: Result<ServiceStatus>) {
    clearTimeout(this.startTimer);
    const finish = this.finishStart;
    this.finishStart = undefined;
    this.starting = undefined;
    finish?.(result);
  }
  private rejectPending(code: ErrorCode) {
    for (const { resolve, timer } of this.pending.values()) { clearTimeout(timer); resolve({ ok: false, error: publicError(code) }); }
    this.pending.clear();
  }
  private fail(code: ErrorCode) {
    if (this.closing || this.status.phase === 'failed') return;
    this.transition('failed', code);
    this.settleStart({ ok: false, error: publicError(code) });
    this.rejectPending(code);
    this.child?.kill();
  }
  private send(message: HostInput) {
    const child = this.child;
    if (!child?.connected) { this.fail('SERVICE_EXITED'); return; }
    try { child.send(message, (error: Error | null) => { if (error && child === this.child) this.fail('SERVICE_EXITED'); }); }
    catch { this.fail('SERVICE_EXITED'); }
  }
  start(): Promise<Result<ServiceStatus>> {
    if (this.closing) return Promise.resolve({ ok: false, error: publicError('SHUTTING_DOWN') });
    if (this.starting) return this.starting;
    if (this.status.phase === 'ready') return Promise.resolve({ ok: true, value: this.snapshot() });
    // A failed generation must finish exiting before a new generation can start.
    if (this.child) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    const promise = new Promise<Result<ServiceStatus>>((resolve) => { this.finishStart = resolve; });
    this.starting = promise;
    this.transition('starting');
    this.nonce = randomUUID();
    this.startTimer = activeTimeout(() => this.fail('START_TIMEOUT'), this.options.startupMs ?? 5000);
    try {
      const forkOptions: ForkOptions & { windowsHide: boolean } = {
        execPath: this.options.nodePath, execArgv: [], env: serviceEnvironment(this.options.dataRoot),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, serialization: 'json',
      };
      const child = fork(this.options.entry, [], forkOptions);
      this.child = child;
      child.on('error', () => { if (child === this.child) this.fail('START_FAILED'); });
      child.on('message', (raw: unknown) => {
        if (child !== this.child || this.closing || this.status.phase === 'failed') return;
        const parsed = hostOutputSchema.safeParse(raw);
        if (!parsed.success) { this.fail('PROTOCOL_ERROR'); return; }
        const message = parsed.data;
        if (message.kind === 'ready') {
          if (this.status.phase !== 'starting' || message.nonce !== this.nonce || message.pid !== child.pid || message.nodeVersion !== SERVICE_NODE_VERSION) { this.fail('PROTOCOL_ERROR'); return; }
          this.transition('ready');
          this.settleStart({ ok: true, value: this.snapshot() });
        } else if (message.kind === 'data-response' || message.kind === 'memories-response' || message.kind === 'files-response' || message.kind === 'response' || message.kind === 'providers-response' || message.kind === 'apps-response' || message.kind === 'skills-response' || message.kind === 'policy-response' || message.kind === 'runs-response' || message.kind === 'chat-response') {
          const pending = this.pending.get(message.id);
          if (this.status.phase !== 'ready' || !pending || pending.kind !== message.kind) { this.fail('PROTOCOL_ERROR'); return; }
          if (message.kind !== 'response' && message.result.ok && pending.operation !== message.result.value.operation) { this.fail('PROTOCOL_ERROR'); return; }
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message.result);
        } else { this.fail(message.error.code); }
      });
      child.once('close', () => {
        if (child !== this.child) return;
        this.child = undefined;
        if (!this.closing && this.status.phase !== 'failed') this.fail('SERVICE_EXITED');
      });
      this.send({ kind: 'hello', version: SERVICE_PROTOCOL_VERSION, nonce: this.nonce });
    } catch { this.child = undefined; this.fail('START_FAILED'); }
    return promise;
  }
  ping(input: unknown): Promise<Result<PingOutput>> {
    const parsed = pingInputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok: false, error: publicError(this.closing ? 'SHUTTING_DOWN' : 'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 3000);
      this.pending.set(id, { kind: 'response', resolve: result => resolve(result as Result<PingOutput>), timer });
      this.send({ kind: 'ping', id, input: parsed.data });
    });
  }
  providers(input: unknown): Promise<Result<ProviderReply>> {
    const parsed = providerRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok: false, error: publicError(this.closing ? 'SHUTTING_DOWN' : 'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 75000);
      this.pending.set(id, { kind: 'providers-response', operation: parsed.data.operation, resolve: result => resolve(result as Result<ProviderReply>), timer });
      this.send({ kind: 'providers', id, input: parsed.data });
    });
  }
  files(input: unknown): Promise<Result<FileHostReply>> {
    const parsed = fileHostRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok:false,error:publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok:false,error:publicError('NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok:false,error:publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID(), timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'),this.options.requestMs ?? 30000);
      this.pending.set(id,{ kind:'files-response',operation:parsed.data.operation,resolve:r => resolve(r as Result<FileHostReply>),timer });
      this.send({ kind:'files',id,input:parsed.data });
    });
  }
  memories(input: unknown): Promise<Result<MemoryReply>> {
    const parsed = memoryRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok: false, error: publicError(this.closing ? 'SHUTTING_DOWN' : 'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 30000);
      this.pending.set(id, { kind: 'memories-response', operation: parsed.data.operation, resolve: result => resolve(result as Result<MemoryReply>), timer });
      this.send({ kind: 'memories', id, input: parsed.data });
    });
  }
  chat(input: unknown): Promise<Result<ChatReply>> {
    const parsed = chatRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok: false, error: publicError(this.closing ? 'SHUTTING_DOWN' : 'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 30000);
      this.pending.set(id, { kind: 'chat-response', operation: parsed.data.operation, resolve: result => resolve(result as Result<ChatReply>), timer });
      this.send({ kind: 'chat', id, input: parsed.data });
    });
  }
  runs(input: unknown): Promise<Result<RunReply>> {
    const parsed = runRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok: false, error: publicError(this.closing ? 'SHUTTING_DOWN' : 'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 30000);
      this.pending.set(id, { kind: 'runs-response', operation: parsed.data.operation, resolve: result => resolve(result as Result<RunReply>), timer });
      this.send({ kind: 'runs', id, input: parsed.data });
    });
  }
  apps(input: unknown): Promise<Result<AppReply>> {
    const parsed = appRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok: false, error: publicError(this.closing ? 'SHUTTING_DOWN' : 'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 30000);
      this.pending.set(id, { kind: 'apps-response', operation: parsed.data.operation, resolve: result => resolve(result as Result<AppReply>), timer });
      this.send({ kind: 'apps', id, input: parsed.data });
    });
  }
  policy(input: unknown): Promise<Result<PolicyHostReply>> {
    const parsed = policyHostRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok: false, error: publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok: false, error: publicError(this.closing ? 'SHUTTING_DOWN' : 'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok: false, error: publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID(), timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 30000);
      this.pending.set(id, { kind: 'policy-response', operation: parsed.data.operation, resolve: result => resolve(result as Result<PolicyHostReply>), timer });
      this.send({ kind: 'policy', id, input: parsed.data });
    });
  }
  data(input:unknown):Promise<Result<DataReply>> {
    const parsed=dataHostRequestSchema.safeParse(input);
    if(!parsed.success)return Promise.resolve({ok:false,error:publicError('INVALID_INPUT')});
    if(this.status.phase!=='ready')return Promise.resolve({ok:false,error:publicError('NOT_READY')});
    if(this.pending.size>=64)return Promise.resolve({ok:false,error:publicError('BUSY')});
    return new Promise(resolve=>{
      const id=randomUUID(),timer=activeTimeout(()=>this.fail('REQUEST_TIMEOUT'),this.options.requestMs??30000);
      this.pending.set(id,{kind:'data-response',operation:parsed.data.operation==='request'?parsed.data.request.operation:'select',resolve:r=>resolve(r as Result<DataReply>),timer});
      this.send({kind:'data',id,input:parsed.data});
    });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true;
    this.transition('stopping');
    this.settleStart({ ok: false, error: publicError('SHUTTING_DOWN') });
    this.rejectPending('SHUTTING_DOWN');
    const child = this.child;
    this.stopping = new Promise<void>((resolve) => {
      if (!child) { resolve(); return; }
      const timer = setTimeout(() => child.kill(), this.options.shutdownMs ?? 15000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      this.send({ kind: 'shutdown' });
    }).then(() => { this.transition('stopped'); });
    return this.stopping;
  }
  skills(input: unknown): Promise<Result<SkillHostReply>> {
    const parsed = skillHostRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ ok:false,error:publicError('INVALID_INPUT') });
    if (this.status.phase !== 'ready') return Promise.resolve({ ok:false,error:publicError(this.closing ? 'SHUTTING_DOWN':'NOT_READY') });
    if (this.pending.size >= 64) return Promise.resolve({ ok:false,error:publicError('BUSY') });
    return new Promise(resolve => {
      const id = randomUUID(), timer = activeTimeout(() => this.fail('REQUEST_TIMEOUT'),this.options.requestMs ?? 60000);
      this.pending.set(id,{ kind:'skills-response',operation:parsed.data.operation,resolve:result => resolve(result as Result<SkillHostReply>),timer });
      this.send({ kind:'skills',id,input:parsed.data });
    });
  }
}
