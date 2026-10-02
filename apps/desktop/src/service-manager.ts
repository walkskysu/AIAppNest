import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hostOutputSchema, pingInputSchema, publicError, type ErrorCode, type HostInput, type PingOutput, type Result, type ServiceStatus } from '@aiappnest/contracts';
import { SERVICE_NODE_VERSION, SERVICE_PROTOCOL_VERSION } from '@aiappnest/domain';

type Pending = { resolve: (result: Result<PingOutput>) => void; timer: NodeJS.Timeout };
export function serviceEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) {
    if (process.env[key]) env[key] = process.env[key];
  }
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
  constructor(private readonly options: { nodePath: string; entry: string; startupMs?: number; requestMs?: number; shutdownMs?: number }) { super(); }
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
    this.startTimer = setTimeout(() => this.fail('START_TIMEOUT'), this.options.startupMs ?? 5000);
    try {
      const forkOptions: ForkOptions & { windowsHide: boolean } = {
        execPath: this.options.nodePath, execArgv: [], env: serviceEnvironment(),
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
        } else if (message.kind === 'response') {
          const pending = this.pending.get(message.id);
          if (this.status.phase !== 'ready' || !pending) { this.fail('PROTOCOL_ERROR'); return; }
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message.result);
        } else { this.fail('PROTOCOL_ERROR'); }
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
      const timer = setTimeout(() => this.fail('REQUEST_TIMEOUT'), this.options.requestMs ?? 3000);
      this.pending.set(id, { resolve, timer });
      this.send({ kind: 'ping', id, input: parsed.data });
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
      const timer = setTimeout(() => child.kill(), this.options.shutdownMs ?? 1500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      this.send({ kind: 'shutdown' });
    }).then(() => { this.transition('stopped'); });
    return this.stopping;
  }
}
