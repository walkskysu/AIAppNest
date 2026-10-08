import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { id } from '@aiappnest/domain';
import type { RunBoundary } from '../../policy/src/service';
import { compileSession, validateSessionPath, type CompiledSession, type EngineServices } from './config';
import { JsonlDecoder } from './jsonl';
import { PolicyBridge } from './policy-bridge';
import { EngineError, type EngineRuntime, type EngineEvent, type EngineResult, type EngineState, type CancellationEvidence } from './types';

interface Pending { type: string; resolve: (value: any) => void; reject: (error: EngineError) => void; timer: NodeJS.Timeout }
interface Active {
  id: string; boundary: RunBoundary; candidate: boolean; handled: boolean; started: boolean; assistant?: any;
  modelError: boolean; tools: Set<string>; toolErrors: number; turns: number;
  usage: { inputTokens: number; outputTokens: number }; cancellation: CancellationEvidence;
}
export interface AdapterOptions {
  /** Interrupt launch only. Active cancellation uses abort() and its evidence. */
  signal?: AbortSignal;
  startupMs?: number; commandMs?: number; closeMs?: number;
  bufferBytes?: number; bufferEvents?: number;
  /** Called synchronously; must not block. Throwing subscribers are isolated. No raw protocol logging. */
  onEvent?: (event: EngineEvent) => void;
}
const leases = new WeakMap<object, Set<string>>();
const idle = (state: any) => state?.isStreaming === false && state?.isCompacting === false && state?.pendingMessageCount === 0;
const cancellation = (): CancellationEvidence => ({ requested: false, acknowledged: false, idle: false, forced: false, exited: false });

/** One Worker owns one exact conversation. Scheduling, persistence of run outcomes and retries belong to the host. */
export class PiAdapter {
  private child?: ChildProcessWithoutNullStreams;
  private bridge: PolicyBridge;
  private pending = new Map<string, Pending>();
  private active?: Active;
  private runPromise?: Promise<EngineResult>;
  private fatal?: EngineError;
  private ready = false;
  private memoryBudget?: number;
  private closing = false;
  private closed = false;
  private exit?: Promise<void>;
  private closePromise?: Promise<void>;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private buffer: { event: EngineEvent; bytes: number }[] = [];
  private bufferSize = 0;
  private sequence = 0;
  private dropped = 0;
  private stderrBytes = 0;
  private unknownEvents = 0;
  private sessionFile = '';
  private constructor(private readonly services: EngineServices, private readonly runtime: EngineRuntime,
    private readonly config: CompiledSession, private readonly options: AdapterOptions) {
    this.bridge = new PolicyBridge(() => this.active?.boundary, () => {
      // Stop authority immediately; allow process close to supply its exit code before classifying a live channel failure.
      this.active?.boundary.cancel();
      const timer = setTimeout(() => { if (!this.closed && !this.closing) this.fail(new EngineError('EXTENSION_FAILED')); }, 100);
      timer.unref();
    });
  }
  static start(services: EngineServices, runtime: EngineRuntime, appId: string, conversationId: string, options: AdapterOptions = {}): Promise<PiAdapter> {
    return this.open(services, runtime, appId, conversationId, false, options);
  }
  static restore(services: EngineServices, runtime: EngineRuntime, appId: string, conversationId: string, options: AdapterOptions = {}): Promise<PiAdapter> {
    return this.open(services, runtime, appId, conversationId, true, options);
  }
  private static async open(services: EngineServices, runtime: EngineRuntime, appId: string, conversationId: string, restore: boolean, options: AdapterOptions): Promise<PiAdapter> {
    let owned = leases.get(services.storage);
    if (!owned) { owned = new Set(); leases.set(services.storage, owned); }
    if (owned.has(conversationId)) throw new EngineError('INVALID_STATE');
    owned.add(conversationId);
    let adapter: PiAdapter | undefined;
    try {
      const config = compileSession(services, runtime, appId, conversationId, restore);
      adapter = new PiAdapter(services, runtime, config, options);
      const abort = () => { void adapter!.close(true).catch(() => {}); };
      if (options.signal?.aborted) throw new EngineError('INVALID_STATE');
      options.signal?.addEventListener('abort', abort, { once: true });
      try { await adapter.launch(); }
      finally { options.signal?.removeEventListener('abort', abort); }
      if (options.signal?.aborted) throw new EngineError('INVALID_STATE');
      return adapter;
    } catch (error) {
      if (adapter) await adapter.close(true);
      else owned.delete(conversationId);
      throw error instanceof EngineError ? error : new EngineError('RESOURCE_INVALID');
    }
  }
  private async launch(): Promise<void> {
    await this.bridge.listen();
    if (this.closing || this.options.signal?.aborted) throw new EngineError('INVALID_STATE');
    const env = { ...this.config.env, AIAPPNEST_POLICY_PIPE: this.bridge.path, AIAPPNEST_POLICY_TOKEN: this.bridge.token };
    this.child = spawn(this.runtime.nativeHost, ['job', String(process.pid), this.runtime.node, ...this.config.args], {
      cwd: this.config.cwd, env, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'],
    });
    // Listeners precede every RPC, including the first state request and prompt.
    const decoder = new JsonlDecoder(value => this.receive(value));
    this.child.stdout.on('data', chunk => { try { decoder.push(chunk); } catch { this.fail(new EngineError('PROTOCOL_ERROR')); } });
    this.child.stdout.on('end', () => {
      try { decoder.end(); } catch { this.fail(new EngineError('PROTOCOL_ERROR')); }
      // close follows end and preserves a real exit code. A live process with closed stdout is retired after a bounded grace.
      const timer = setTimeout(() => { if (!this.closed && !this.closing) this.fail(new EngineError('PROTOCOL_ERROR')); }, 100);
      timer.unref();
    });
    this.child.stderr.on('data', chunk => { this.stderrBytes += chunk.length; });
    this.child.stdin.on('error', () => this.fail(new EngineError('PROTOCOL_ERROR')));
    this.child.on('error', () => this.fail(new EngineError('SPAWN_FAILED')));
    this.exit = new Promise(resolve => this.child!.once('close', (code, signal) => {
      this.closed = true; this.exitCode = code; this.exitSignal = signal;
      if (this.active) this.active.cancellation.exited = true;
      this.fail(new EngineError('PROCESS_EXIT', code, signal)); resolve();
    }));
    const deadline = Date.now() + (this.options.startupMs ?? 15000);
    const state = (await this.request('get_state', {}, deadline, 'START_TIMEOUT')).data;
    await this.until(() => this.ready, deadline, 'START_TIMEOUT');
    if (state.model?.provider !== 'aiappnest' || state.model?.id !== this.config.modelId || !idle(state)) throw new EngineError('RESOURCE_INVALID');
    const commands = (await this.request('get_commands', {}, deadline, 'START_TIMEOUT')).data?.commands;
    if (!Array.isArray(commands) || !commands.some(c => c.name === 'aiappnest-barrier')) throw new EngineError('EXTENSION_FAILED');
    const file = validateSessionPath(this.services, this.config, state.sessionFile, this.config.sessionFile !== null);
    if (this.config.sessionFile && file !== this.config.sessionFile) throw new EngineError('SESSION_INVALID');
    try { this.services.storage.attachSessionFile(id<'app'>(this.config.scope.appId), id<'conversation'>(this.config.scope.conversationId), file); }
    catch { throw new EngineError('MAPPING_FAILED'); }
    this.sessionFile = file;
    this.emit('status', { state: 'idle' });
  }
  private emit(type: EngineEvent['type'], payload: Record<string, unknown>): void {
    const limit = this.options.bufferBytes ?? 256 * 1024;
    let event: EngineEvent = { ...this.config.scope, runId: this.active?.id ?? null, seq: ++this.sequence, type, payload };
    let bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > Math.min(limit, 64 * 1024)) {
      event = { ...event, type: 'output.truncated', payload: { source: type, originalBytes: bytes } };
      bytes = Buffer.byteLength(JSON.stringify(event)); this.dropped++;
    }
    while (this.buffer.length && (this.bufferSize + bytes > limit || this.buffer.length >= (this.options.bufferEvents ?? 512))) {
      this.bufferSize -= this.buffer.shift()!.bytes; this.dropped++;
    }
    if (bytes <= limit) { this.buffer.push({ event, bytes }); this.bufferSize += bytes; }
    else this.dropped++;
    try { this.options.onEvent?.(structuredClone(event)); } catch { /* subscriber failure never stops draining stdout */ }
  }
  /** Projection window only; durable messages are read through getMessages(). */
  readEvents(afterSeq = 0) {
    return { events: structuredClone(this.buffer.filter(item => item.event.seq > afterSeq).map(item => item.event)),
      dropped: this.dropped, lastSeq: this.sequence, bufferedBytes: this.bufferSize, stderrBytes: this.stderrBytes, unknownEvents: this.unknownEvents };
  }
  private receive(value: any): void {
    if (this.fatal) return;
    if (value.type === 'response') {
      const item = this.pending.get(value.id);
      if (!item) { this.unknownEvents++; return; }
      if (value.command !== item.type || typeof value.success !== 'boolean') { this.fail(new EngineError('PROTOCOL_ERROR')); return; }
      this.pending.delete(value.id); clearTimeout(item.timer);
      if (value.success) item.resolve(value); else item.reject(new EngineError('PROTOCOL_ERROR'));
      return;
    }
    if (value.type === 'extension_ui_request') {
      if (value.method === 'notify' && value.message === 'AIAPPNEST_READY_V1') this.ready = true;
      else if (value.method === 'notify' && value.message === 'AIAPPNEST_HANDLED_V1' && this.active) this.active.handled = true;
      else if (value.method === 'notify' && typeof value.message === 'string' && /^AIAPPNEST_MEMORY_BUDGET_V1:\d+$/.test(value.message)) this.memoryBudget = Number(value.message.split(':')[1]);
      else this.unknownEvents++;
      return;
    }
    if (['extension_error','auto_retry_start','auto_compaction_start'].includes(value.type)) { this.fail(new EngineError('EXTENSION_FAILED')); return; }
    const run = this.active;
    if (!run) { this.unknownEvents++; return; }
    switch (value.type) {
      case 'agent_start': run.started = true; run.candidate = false; this.emit('status', { state: 'running' }); break;
      case 'agent_end': run.candidate = true; break;
      case 'message_update':
        if (value.assistantMessageEvent?.type === 'text_delta' && typeof value.assistantMessageEvent.delta === 'string') this.emit('assistant.delta', { text: value.assistantMessageEvent.delta });
        break;
      case 'message_end':
        if (value.message?.role === 'assistant') {
          run.assistant = value.message;
          run.modelError ||= value.message.stopReason === 'error';
          const usage = value.message.usage;
          if (usage && Number.isSafeInteger(usage.input) && Number.isSafeInteger(usage.output) && usage.input >= 0 && usage.output >= 0) {
            run.usage.inputTokens += usage.input; run.usage.outputTokens += usage.output;
            this.emit('usage', { ...run.usage });
          }
        }
        break;
      case 'tool_execution_start':
        if (typeof value.toolCallId !== 'string' || typeof value.toolName !== 'string') { this.fail(new EngineError('PROTOCOL_ERROR')); break; }
        run.tools.add(value.toolCallId); this.emit('tool.started', { callId: value.toolCallId, name: value.toolName }); break;
      case 'tool_execution_end':
        run.tools.delete(value.toolCallId); if (value.isError === true) run.toolErrors++;
        this.emit('tool.result', { callId: value.toolCallId, name: value.toolName, isError: value.isError === true, result: value.result }); break;
      case 'turn_end': if (++run.turns > this.config.maxTurns) this.fail(new EngineError('RUN_TIMEOUT')); break;
      case 'message_start': case 'turn_start': case 'tool_execution_update': break;
      default: this.unknownEvents++;
    }
  }
  private fail(error: EngineError): void {
    if (this.fatal) return;
    this.fatal = error;
    this.active?.boundary.cancel();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (!this.closing) this.emit('error', { code: error.code, exitCode: error.exitCode, signal: error.signal });
    if (!this.closed) this.child?.kill();
    // Diagnostic callers may have no active execute() awaiting the failure. Always retire resources.
    if (!this.closing) void this.close(true).catch(() => {});
  }
  private request(type: string, fields: Record<string, unknown> = {}, deadline = Date.now() + (this.options.commandMs ?? 15000), timeoutCode: 'COMMAND_TIMEOUT' | 'START_TIMEOUT' = 'COMMAND_TIMEOUT'): Promise<any> {
    if (this.fatal || this.closing) return Promise.reject(this.fatal ?? new EngineError('INVALID_STATE'));
    if (this.pending.size >= 32) return Promise.reject(new EngineError('INVALID_STATE'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new EngineError(timeoutCode)), Math.max(1, deadline - Date.now()));
      this.pending.set(requestId, { type, resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ type, id: requestId, ...fields }) + '\n');
    });
  }
  private async until(predicate: () => boolean, deadline: number, code: 'RUN_TIMEOUT' | 'START_TIMEOUT' = 'RUN_TIMEOUT'): Promise<void> {
    while (!predicate()) {
      if (this.fatal) throw this.fatal;
      if (Date.now() >= deadline) throw new EngineError(code);
      await delay(5);
    }
    if (this.fatal) throw this.fatal;
  }
  async getState(): Promise<EngineState> {
    if (this.closed || this.closing) return { ...this.config.scope, status: 'closed', sessionFile: this.sessionFile, streaming: false, pendingMessages: 0 };
    const state = (await this.request('get_state')).data;
    this.checkFile(state);
    return { ...this.config.scope, status: this.active ? this.active.cancellation.requested ? 'cancelling' : 'running' : 'idle',
      sessionFile: this.sessionFile, streaming: state.isStreaming, pendingMessages: state.pendingMessageCount };
  }
  /** Bounded RPC snapshot for reconciliation, never direct edits of Pi JSONL. */
  async getMessages(): Promise<readonly unknown[]> {
    const data = (await this.request('get_messages')).data;
    if (!Array.isArray(data?.messages)) { this.fail(new EngineError('PROTOCOL_ERROR')); throw this.fatal; }
    return data.messages;
  }
  async getMemoryBudget(text: string): Promise<number> {
    if (this.active || this.closing || this.fatal) throw new EngineError('INVALID_STATE');
    this.memoryBudget = undefined;
    await this.request('prompt', { message:'/aiappnest-memory-budget' });
    if (this.memoryBudget === undefined) throw new EngineError('PROTOCOL_ERROR');
    const history = await this.getMessages();
    // Raw message JSON overestimates rendered history; reserve input plus framing too.
    return Math.max(0,this.memoryBudget - Buffer.byteLength(JSON.stringify(history)) - Buffer.byteLength(text)
      - (text.startsWith('/skill:') ? this.config.skillExpansionBytes : 0));
  }
  private checkFile(state: any): void {
    if (state?.sessionFile !== this.sessionFile) { this.fail(new EngineError('SESSION_INVALID')); throw this.fatal; }
  }
  prompt(runId: string, text: string): Promise<EngineResult> {
    if (this.active || this.closing || this.fatal) return Promise.reject(new EngineError('INVALID_STATE'));
    // Extension commands may have no agent events. Only the explicit handled command and validated Skills are allowed.
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1024 * 1024
      || (/^\s*\//.test(text) && !/^\/skill:[\w-]+(?:\s|$)/.test(text) && text !== '/aiappnest-handled')) return Promise.reject(new EngineError('INVALID_INPUT'));
    try {
      const record = this.services.storage.runs.get({ appId: id<'app'>(this.config.scope.appId), id: id<'run'>(runId) });
      if (record.conversationId !== this.config.scope.conversationId) throw new EngineError('INVALID_INPUT');
      this.services.apps.resolveSkills(this.config.scope.appId, this.config.scope.revisionId);
      const boundary = this.services.policy.bindRun(this.config.scope.appId, runId);
      if (!isDeepStrictEqual([...boundary.tools].sort(), [...this.config.tools].sort())) { boundary.cancel(); throw new EngineError('RESOURCE_INVALID'); }
      this.active = { id: runId, boundary, candidate: false, handled: false, started: false, modelError: false,
        tools: new Set(), toolErrors: 0, turns: 0, usage: { inputTokens: 0, outputTokens: 0 }, cancellation: cancellation() };
      this.runPromise = this.execute(text, this.active);
      return this.runPromise;
    } catch (error) { return Promise.reject(error instanceof EngineError ? error : new EngineError('RESOURCE_INVALID')); }
  }
  private async execute(text: string, run: Active): Promise<EngineResult> {
    const deadline = Date.now() + this.config.timeoutMs;
    let result: EngineResult;
    const base = () => ({ runId: run.id, toolErrors: run.toolErrors, usage: run.usage, cancellation: run.cancellation });
    try {
      await this.request('prompt', { message: text }, deadline);
      this.emit('status', { state: 'accepted' });
      await this.until(() => run.candidate || run.handled, deadline);
      await this.request('prompt', { message: '/aiappnest-barrier' }, deadline);
      const state = (await this.request('get_state', {}, deadline)).data;
      this.checkFile(state);
      const messages = (await this.request('get_messages', {}, deadline)).data?.messages;
      if (!idle(state) || !Array.isArray(messages) || run.tools.size) throw new EngineError('INCOMPLETE_RESULT');
      run.cancellation.idle = true;
      if (this.fatal) throw this.fatal;
      // A handled marker is valid only if no agent/tool work started in this run.
      const handled = run.handled && !run.started && !run.assistant;
      const complete = run.started && run.assistant?.stopReason === 'stop' && isDeepStrictEqual(run.assistant, messages.at(-1));
      const cancelled = run.cancellation.requested || run.assistant?.stopReason === 'aborted';
      result = { ...base(), status: cancelled ? 'cancelled' : run.modelError ? 'failed' : handled ? 'handled' : complete ? 'succeeded' : 'failed',
        ...(run.modelError ? { error: 'MODEL_ERROR' as const } : !cancelled && !handled && !complete ? { error: 'INCOMPLETE_RESULT' as const } : {}) };
    } catch (error) {
      const engineError = error instanceof EngineError ? error : new EngineError('PROTOCOL_ERROR');
      this.fail(engineError);
      try { await this.close(true); } catch { /* retain original failure, expose absence of exit evidence */ }
      result = { ...base(), status: run.cancellation.requested && this.closed ? 'cancelled' : 'interrupted',
        error: engineError.code, exitCode: this.exitCode, signal: this.exitSignal };
    } finally { run.boundary.cancel(); }
    this.emit('status', { state: result.status, toolErrors: run.toolErrors });
    this.active = undefined;
    return structuredClone(result);
  }
  async abort(timeoutMs = 1500): Promise<CancellationEvidence> {
    const run = this.active;
    if (!run) return cancellation();
    run.cancellation.requested = true; run.boundary.cancel();
    this.emit('status', { state: 'cancelling' });
    const deadline = Date.now() + timeoutMs;
    try {
      await this.request('abort', {}, deadline); run.cancellation.acknowledged = true;
      await this.until(() => !this.active, deadline);
    } catch {
      run.cancellation.forced = true;
      await this.close(true);
      run.cancellation.exited = this.closed;
      if (this.runPromise) await this.runPromise;
    }
    return structuredClone(run.cancellation);
  }
  close(force = false): Promise<void> {
    if (!this.closePromise) this.closePromise = this.shutdown(force);
    return this.closePromise;
  }
  private async shutdown(force: boolean): Promise<void> {
    this.closing = true;
    if (this.active) {
      if (!this.fatal) this.active.cancellation.requested = true;
      this.active.boundary.cancel();
      if (force && this.active.cancellation.requested) this.active.cancellation.forced = true;
    }
    this.bridge.close();
    // Pi's stdin EOF cancels and clears its pending input queue. Adapter never permits steer/follow_up.
    if (force) this.child?.kill(); else this.child?.stdin.end();
    const wait = async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.exit ?? Promise.resolve(), new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.closeMs ?? 1500); })]);
      clearTimeout(timer);
    };
    await wait();
    if (this.child && !this.closed) { this.child.kill(); await wait(); }
    if (this.child && !this.closed) throw new EngineError('CLOSE_TIMEOUT');
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(this.fatal ?? new EngineError('INVALID_STATE')); }
    this.pending.clear();
    leases.get(this.services.storage)?.delete(this.config.scope.conversationId);
  }
}
