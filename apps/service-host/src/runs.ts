import { MemoryService } from '../../../packages/memory/src/index';
import { FileService, FileError } from './files';
import { createHash, randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { DomainError, id, timestamp, terminalRunStates, type Run, type RunState, type RunEvent } from '@aiappnest/domain';
import { publicError, runRequestSchema, type RunRequest, type RunReply, type Result, type ErrorCode, grantSchema } from '@aiappnest/contracts';
import type { Storage } from '@aiappnest/storage';
import { PiAdapter, EngineError, type EngineEvent, type EngineResult, type EngineRuntime } from '../../../packages/pi-adapter/src/index';
import type { EngineServices } from '../../../packages/pi-adapter/src/config';
import type { PolicyService } from '../../../packages/policy/src/service';
import { canonicalDirectory } from '../../../packages/policy/src/paths';
import { Recovery } from './recovery';
import { DiagnosticLog, diagnostics } from './diagnostics';
import { displayText, projectionId } from '../../../packages/pi-adapter/src/session-reader';

type Submit = Extract<RunRequest, { operation: 'submit' }>;
export interface Worker {
  prompt(runId: string, text: string): Promise<EngineResult>;
  abort(timeoutMs?: number): Promise<unknown>;
  close(force?: boolean): Promise<void>;
  getMessages(): Promise<readonly unknown[]>;
  getMemoryBudget?(text: string): Promise<number>;
}
export interface RunPlan { model: string; local: boolean; roots: string[]; exclusive: boolean; text: string; snapshot: Record<string, unknown>; workerKey?: string }
export interface SchedulerOptions {
  concurrency?: number; localConcurrency?: number; modelLimits?: Record<string, number>; queueLimit?: number;
  queueTimeoutMs?: number; idleTtlMs?: number; abortMs?: number;
  prepare?: (input: Submit) => RunPlan;
  open?: (run: Run, signal: AbortSignal, onEvent: (event: EngineEvent) => void) => Promise<Worker>;
}
interface Job { run: Run; input: Submit; plan: RunPlan; controller: AbortController; done?: Promise<void>; worker?: Worker; cancel?: Promise<unknown>; outputBytes?: number; truncated?: boolean; suspendedMs?: number }
const terminal = (run: Run) => terminalRunStates.includes(run.state);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const overlaps = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
const conflict = (a: Job, b: Job) => a.run.conversationId === b.run.conversationId || a.plan.exclusive || b.plan.exclusive
  || a.plan.roots.some(x => b.plan.roots.some(y => overlaps(x, y)));

/** Single writer scheduler. Locks are acquired atomically (conversation, global, model, sorted roots).
 * FIFO among conflicting jobs; independent work may pass blocked jobs. No engine or host retries. */
export class RunScheduler {
  private queue: Job[] = [];
  private active = new Map<string, Job>();
  private workers = new Map<string, { worker: Worker; workerKey?: string; idleAt: number; busy: boolean; retiring?: Promise<void> }>();
  private subscriptions = new Map<string, { appId: string; conversationId: string; runId: string; expires: number }>();
  private pending: { run: Run; type: string; payload: unknown }[] = [];
  private pendingBytes = 0;
  private stopped = false;
  private failed = false;
  private closing?: Promise<void>;
  private timer: NodeJS.Timeout;
  private pumping = false;
  private retiring = new Set<string>();
  private recovery: Recovery;
  private log: DiagnosticLog;
  private lastTick=Date.now();
  /** Seal new submissions before cancellation. Idle workers also exit before soft deletion. */
  retireConversation(appId: string, conversationId: string): boolean {
    this.storage.conversations.get({ appId: id<'app'>(appId), id: id<'conversation'>(conversationId) });
    this.retiring.add(conversationId);
    for (const job of [...this.queue, ...this.active.values()]) if (job.run.conversationId === conversationId) this.cancel(this.getRun(appId,conversationId,job.run.id));
    if ([...this.active.values()].some(job => job.run.conversationId === conversationId)) return false;
    const entry = this.workers.get(conversationId);
    if (entry) {
      entry.retiring ??= entry.worker.close(true).then(() => { this.workers.delete(conversationId); }, () => this.storageFailure());
      return false;
    }
    return true;
  }
  constructor(private readonly services: EngineServices & { policy: PolicyService; files?: FileService }, private readonly runtime: EngineRuntime,
    private readonly options: SchedulerOptions = {}) {
    for (const value of [options.concurrency ?? 2, options.localConcurrency ?? 1, options.queueLimit ?? 100,
      options.queueTimeoutMs ?? 300000, options.idleTtlMs ?? 300000, options.abortMs ?? 1500, ...Object.values(options.modelLimits ?? {})]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new DomainError('INVALID_INPUT');
    }
    this.recovery = new Recovery(this.storage);
    this.log = new DiagnosticLog(this.storage);
    this.recovery.reconcile();
    services.policy.on('event', this.policyEvent);
    this.timer = setInterval(() => { try { this.flush(); this.tick(); } catch { this.storageFailure(); } }, 40);
    this.timer.unref();
  }
  private get storage(): Storage { return this.services.storage; }
  private getRun(appId: string, conversationId: string, runId: string) {
    const run = this.storage.runs.get({ appId: id<'app'>(appId), id: id<'run'>(runId) });
    if (run.conversationId !== conversationId) throw new DomainError('NOT_FOUND');
    return run;
  }
  request(raw: unknown): Result<RunReply> {
    const parsed = runRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    try { return { ok: true, value: this.dispatch(parsed.data) }; }
    catch (error) {
      if (error instanceof FileError) return { ok:false,error:publicError(error.code) };
      const code = error instanceof DomainError ? error.code : 'NOT_READY';
      if (code === 'STORAGE_UNAVAILABLE') this.storageFailure();
      const exposed: ErrorCode = ['NOT_FOUND','VERSION_CONFLICT','INVALID_INPUT','STORAGE_UNAVAILABLE','BUSY','SHUTTING_DOWN','NOT_READY'].includes(code) ? code as ErrorCode : 'NOT_READY';
      return { ok: false, error: publicError(exposed) };
    }
  }
  private dispatch(input: RunRequest): RunReply {
    if (input.operation === 'unsubscribe') { this.subscriptions.delete(input.subscriptionId); return { operation: input.operation }; }
    if (input.operation === 'next') {
      const subscription = this.subscriptions.get(input.subscriptionId);
      if (!subscription || subscription.expires <= Date.now()) throw new DomainError('NOT_FOUND');
      subscription.expires = Date.now() + 60000;
      return this.readSubscription(input.operation, input.subscriptionId, input.afterSeq, subscription);
    }
    if (input.operation === 'submit') return this.submit(input);
    const run = this.getRun(input.appId, input.conversationId, input.runId);
    if (input.operation === 'get') return { operation: input.operation, run,storage:this.failed ? 'unsaved':'saved' };
    if (input.operation === 'diagnostics' || input.operation === 'diagnostics.export') return { operation:input.operation,diagnostic:diagnostics(this.storage,run,this.failed,this.log.saved) };
    if (input.operation === 'repair') {
      if (this.failed) throw new DomainError('STORAGE_UNAVAILABLE');
      if (!terminal(run) || [...this.active.values()].some(j => j.run.conversationId === run.conversationId)) return { operation:'repair',status:'busy',inserted:0,confirmed:false };
      const report = this.recovery.repair(run);
      this.storage.appendEvent(run.appId,run.id,'recovery.repair',report);
      return { operation:'repair',...report };
    }
    if (input.operation === 'cancel') {
      const next = this.cancel(run);
      return { operation: input.operation, run: next, accepted: true, terminated: terminal(next) };
    }
    if (input.operation !== 'subscribe') throw new DomainError('INVALID_INPUT');
    if (this.subscriptions.size >= 128) throw new DomainError('BUSY');
    const subscriptionId = randomUUID(), subscription = { ...input, expires: Date.now() + 60000 };
    this.subscriptions.set(subscriptionId, subscription);
    return this.readSubscription('subscribe', subscriptionId, input.afterSeq, subscription);
  }
  private readSubscription(operation: 'subscribe' | 'next', subscriptionId: string, afterSeq: number,
    scope: { appId: string; conversationId: string; runId: string }): RunReply {
    if (!this.failed) this.flush();
    const run = this.getRun(scope.appId, scope.conversationId, scope.runId);
    const events = this.storage.eventsAfter(run.appId, run.id, afterSeq);
    const snapshotSeq = this.storage.eventHead(run.appId,run.id);
    const resetRequired = afterSeq > snapshotSeq || (events.length > 0 && events[0]!.seq !== afterSeq+1)
      || events.some((e,i) => i > 0 && e.seq !== events[i-1]!.seq+1);
    const cursor = events.at(-1)?.seq ?? afterSeq;
    return { operation, subscriptionId, events:resetRequired ? []:events, afterSeq:resetRequired ? snapshotSeq:cursor,resetRequired,snapshotSeq,storage:this.failed ? 'unsaved':'saved',
      terminal: terminal(run) && this.storage.eventsAfter(run.appId, run.id, cursor, 1).length === 0 };
  }
  private prepare(input: Submit): RunPlan {
    const { snapshot } = this.services.apps.readRevision(input.appId, input.revisionId);
    this.services.apps.resolveSkills(input.appId, input.revisionId);
    // Resolve credentials before admission; never persist plaintext. Adapter snapshots again before launch.
    const credentials = this.services.providers.snapshotRuntime(snapshot.credentialBinding, snapshot.provider);
    const availableGrants = this.storage.policyRecords('grant', input.appId, input.conversationId).map(raw => grantSchema.parse(JSON.parse(raw)))
      .filter(g => !g.revoked && g.revisionId === input.revisionId && snapshot.config.permissions.tools.includes(g.access));
    const grants = availableGrants.filter(g => g.access === 'write');
    const roots = snapshot.config.permissions.tools.includes('write') ? grants.map(g => canonicalDirectory(g.root)) : [];
    let text = input.text + (this.services.files ?? new FileService(this.storage)).attachmentText(input,input.attachmentIds);
    if (availableGrants.length) text += `\n<file-capabilities>Use relative paths with these host-verified grants. Completed writes are registered as artifacts.\n${JSON.stringify(availableGrants.map(g => ({ grantId:g.id,resource:g.resource,access:g.access })))}\n</file-capabilities>`;
    if (Buffer.byteLength(text) > 1024 * 1024) throw new DomainError('INVALID_INPUT');
    return { model: hash([snapshot.provider.endpoint, snapshot.provider.modelId]), local: snapshot.provider.providerType === 'local-openai',
      roots: [...new Set(roots.map(root => process.platform === 'win32' ? root.toLowerCase() : root))].sort(),
      exclusive: snapshot.config.permissions.mode === 'trusted-automation', text, workerKey: hash([snapshot, credentials]),
      snapshot: { revisionId: input.revisionId, configHash: hash(snapshot), permissions: snapshot.config.permissions,
        grants: grants.map(g => ({ id: g.id, version: g.version, root: g.root })), model: hash([snapshot.provider.endpoint, snapshot.provider.modelId]),
        credentialBinding: snapshot.credentialBinding, attachmentIds: input.attachmentIds } };
  }
  private submit(input: Submit): RunReply {
    const appId = id<'app'>(input.appId), conversationId = id<'conversation'>(input.conversationId);
    const conversation = this.storage.conversations.get({ appId, id: conversationId });
    const fingerprint = hash({ revisionId: input.revisionId, text: input.text, attachmentIds: input.attachmentIds, ...(input.retryOf ? { retryOf: input.retryOf } : {}) });
    const existing = this.storage.findRun(appId, conversationId, id<'request'>(input.requestId));
    if (existing) {
      const first = this.storage.eventsAfter(appId, existing.id, 0, 1)[0];
      if ((first?.payload as { fingerprint?: string })?.fingerprint !== fingerprint) throw new DomainError('VERSION_CONFLICT');
      return { operation: 'submit', run: existing, duplicate: true };
    }
    if (this.stopped) throw new DomainError('SHUTTING_DOWN');
    if (this.retiring.has(conversationId)) throw new DomainError('INVALID_INPUT');
    if (this.failed) throw new DomainError('STORAGE_UNAVAILABLE');
    if (conversation.revisionId !== input.revisionId) throw new DomainError('VERSION_CONFLICT');
    const app = this.storage.apps.get({ id: appId });
    if (conversation.status !== 'active' || app.status === 'archived' || (app.status !== 'ready' && !this.storage.trialForConversation(appId,conversationId))) throw new DomainError('INVALID_INPUT');
    if (input.retryOf) {
      const previous = this.getRun(appId,conversationId,input.retryOf);
      if (!terminal(previous)) throw new DomainError('INVALID_INPUT');
    }
    if (!input.text.trim() || Buffer.byteLength(input.text) > 1024 * 1024
      || (/^\s*\//.test(input.text) && !/^\/skill:[\w-]+(?:\s|$)/.test(input.text) && input.text !== '/aiappnest-handled')) throw new DomainError('INVALID_INPUT');
    if (this.queue.length >= (this.options.queueLimit ?? 100)) throw new DomainError('BUSY');
    const plan = (this.options.prepare ?? this.prepare.bind(this))(input);
    const run = this.storage.transaction(() => {
      const run = this.storage.createRun({ id: id<'run'>(randomUUID()), appId, conversationId, requestId: id<'request'>(input.requestId),
        state: 'queued', phase: 'created', version: 1, createdAt: timestamp(), startedAt: null, endedAt: null, error: null, usage: null });
      this.storage.messages.insert({ id: id<'message'>(randomUUID()), appId, conversationId, runId: run.id,
        role: 'user', content: input.text, status: 'complete', createdAt: timestamp() });
      this.storage.appendEvent(appId, run.id, 'run.queued', { fingerprint, retryOf: input.retryOf ?? null, ...plan.snapshot });
      this.storage.linkAttachments(run,input.attachmentIds);
      return run;
    });
    this.queue.push({ run, input, plan, controller: new AbortController() });
    this.schedule();
    return { operation: 'submit', run, duplicate: false };
  }
  private schedule() {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => { this.pumping = false; try { this.tick(); } catch { this.storageFailure(); } });
  }
  private tick() {
    const now=Date.now(),gap=now-this.lastTick;this.lastTick=now;
    if (gap>5000) for (const job of this.queue) job.suspendedMs=(job.suspendedMs ?? 0)+gap;
    for (const [key, sub] of this.subscriptions) if (sub.expires <= Date.now()) this.subscriptions.delete(key);
    for (const [key, entry] of this.workers) if (!entry.busy && !entry.retiring && Date.now() - entry.idleAt >= (this.options.idleTtlMs ?? 300000)) {
      entry.retiring = entry.worker.close().then(() => { this.workers.delete(key); this.schedule(); }, () => this.storageFailure());
    }
    if (this.stopped || this.failed) return;
    const earlier: Job[] = [];
    for (const job of [...this.queue]) {
      if (Date.now() - job.run.createdAt - (job.suspendedMs ?? 0) >= (this.options.queueTimeoutMs ?? 300000)) {
        this.queue.splice(this.queue.indexOf(job), 1); this.finish(job.run, 'cancelled', 'QUEUE_TIMEOUT'); continue;
      }
      const active = [...this.active.values()];
      const limit = this.options.modelLimits?.[job.plan.model] ?? (job.plan.local ? this.options.localConcurrency ?? 1 : this.options.concurrency ?? 2);
      if (active.length >= (this.options.concurrency ?? 2) || active.filter(j => j.plan.model === job.plan.model).length >= limit
        || active.some(j => conflict(j, job)) || earlier.some(j => conflict(j, job))
        || this.workers.get(job.run.conversationId)?.retiring) { earlier.push(job); continue; }
      // Refresh authority before taking locks; it may have changed during queue wait.
      try { const refreshed = (this.options.prepare ?? this.prepare.bind(this))(job.input); job.plan = refreshed; }
      catch { this.queue.splice(this.queue.indexOf(job), 1); this.finish(job.run, 'cancelled', 'CONFIGURATION_UNAVAILABLE'); continue; }
      if (active.some(j => conflict(j, job)) || earlier.some(j => conflict(j, job))) { earlier.push(job); continue; }
      this.queue.splice(this.queue.indexOf(job), 1);
      job.run = this.change(job.run, 'starting');
      this.active.set(job.run.id, job);
      job.done = this.execute(job);
    }
  }
  private change(run: Run, state: RunState): Run {
    return this.storage.transaction(() => {
      const current = this.getRun(run.appId, run.conversationId, run.id);
      const next = this.storage.transitionRun(run.appId, run.id, current.version, state);
      this.storage.appendEvent(run.appId, run.id, 'run.state', { state, phase: next.phase }); return next;
    });
  }
  private cancel(run: Run): Run {
    if (terminal(run) || run.state === 'cancelling') return run;
    const index = this.queue.findIndex(job => job.run.id === run.id);
    if (index >= 0) { this.queue.splice(index, 1); this.finish(run, 'cancelled'); this.schedule(); }
    else {
      const job = this.active.get(run.id);
      if (!job) throw new DomainError('NOT_FOUND');
      // Stop this conversation's pending platform input before aborting its current prompt.
      for (const queued of [...this.queue]) if (queued.run.conversationId === run.conversationId) {
        this.queue.splice(this.queue.indexOf(queued), 1); this.finish(queued.run, 'cancelled', 'CANCELLED_WITH_ACTIVE_RUN');
      }
      job.run = this.change(run, 'cancelling'); job.controller.abort();
      this.services.policy.cancel(run.id);
      if (job.worker) job.cancel = job.worker.abort(this.options.abortMs ?? 1500).catch(() => job.worker!.close(true));
    }
    return this.getRun(run.appId, run.conversationId, run.id);
  }
  private async execute(job: Job) {
    const key = job.run.conversationId;
    let reusable = false;
    try {
      this.services.policy.reserve(job.run.appId, job.run.id);
      this.storage.appendEvent(job.run.appId, job.run.id, 'run.snapshot', job.plan.snapshot);
      let cached = this.workers.get(key);
      if (cached && cached.workerKey !== job.plan.workerKey) {
        cached.busy = true; await cached.worker.close(); this.workers.delete(key); cached = undefined;
      }
      if (cached) { cached.busy = true; job.worker = cached.worker; }
      else {
        const open = this.options.open ?? ((run, signal, onEvent) => {
          const conversation = this.storage.conversations.get({ appId: run.appId, id: run.conversationId });
          return PiAdapter[conversation.piSessionFile ? 'restore' : 'start'](this.services, this.runtime, run.appId, run.conversationId, { signal, onEvent });
        });
        job.worker = await open(job.run, job.controller.signal, event => this.engineEvent(event));
        this.workers.set(key, { worker: job.worker, workerKey: job.plan.workerKey, busy: true, idleAt: 0 });
      }
      if (job.controller.signal.aborted) { await job.worker.close(true); this.finish(job.run, 'cancelled'); return; }
      this.storage.appendEvent(job.run.appId, job.run.id, 'worker.ready', {});
      let memory = '';
      try {
        const { snapshot } = this.services.apps.readRevision(job.run.appId,job.input.revisionId);
        if (snapshot.config.memory.enabled && !this.storage.trialForConversation(job.run.appId,job.run.conversationId) && job.input.text !== '/aiappnest-handled') {
          if (!job.worker.getMemoryBudget) throw new Error('MEMORY_BUDGET_UNAVAILABLE');
          const remaining = await job.worker.getMemoryBudget(job.plan.text);
          if (job.controller.signal.aborted) { await job.worker.close(true); this.finish(job.run,'cancelled'); return; }
          memory = new MemoryService(this.storage).inject(job.run,job.input.text,snapshot.config.memory,remaining);
        }
      } catch (error) { if (error instanceof DomainError && error.code === 'STORAGE_UNAVAILABLE') throw error;throw new Error('MEMORY_PREPARATION_FAILED'); }
      // No await between final memory validation/audit and dispatch. Later deletion cannot retract sent context.
      const engineText = job.plan.text + (memory && /^\/skill:[\w-]+$/.test(job.plan.text) ? ' ' : '') + memory;
      this.recovery.beforePrompt(job.run,engineText);
      const result = await job.worker.prompt(job.run.id, engineText);
      if (this.failed) return;
      if (job.cancel) {
        const evidence = await job.cancel;
        if (evidence && typeof evidence === 'object') result.cancellation = { ...result.cancellation, ...evidence };
      }
      let content = '';
      if (!job.controller.signal.aborted && (result.status === 'succeeded' || result.status === 'handled')) {
        const messages = await job.worker.getMessages() as { role?: string; content?: { type: string; text?: string }[] }[];
        const last = messages.at(-1);
        if (result.status !== 'handled' && last?.role === 'assistant') content = (last.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
      }
      const current = this.getRun(job.run.appId, key, job.run.id);
      let state: RunState = job.controller.signal.aborted ? 'cancelled' : result.toolErrors > 0 && result.status === 'succeeded' ? 'failed' : result.status;
      if (state === 'cancelled' && current.state !== 'cancelling') this.change(current, 'cancelling');
      if (state === 'succeeded' && current.state === 'starting') this.change(current, 'running');
      // Cancellation retires the whole Job, including any tool descendants, even after cooperative abort.
      reusable = !job.controller.signal.aborted && ['succeeded','handled'].includes(result.status);
      if (!reusable) await job.worker.close(true);
      if (job.controller.signal.aborted) {
        state = 'cancelled'; content = '';
        result.cancellation = { ...result.cancellation, requested: true, exited: true };
      }
      this.flush();
      this.recovery.witness(job.run,state,result.usage);
      this.finish(job.run,state,result.error ?? null,content,result,true);
      if (this.getRun(job.run.appId,key,job.run.id).error === 'SESSION_INVALID') { reusable=false;await job.worker.close(true); }
    } catch (error) {
      reusable = false;
      if (error instanceof DomainError && error.code === 'STORAGE_UNAVAILABLE') this.storageFailure();
      try {
        await job.worker?.close(true);
        if (this.failed) return;
        const current = this.getRun(job.run.appId, key, job.run.id);
        this.finish(job.run, job.controller.signal.aborted ? 'cancelled' : current.state === 'starting' ? 'failed' : 'interrupted',
          error instanceof EngineError ? error.code : error instanceof Error && error.message === 'MEMORY_PREPARATION_FAILED' ? 'MEMORY_PREPARATION_FAILED' : 'WORKER_FAILED');
      } catch { this.storageFailure(); }
    } finally {
      this.services.policy.release(job.run.id);
      if (reusable) { const entry = this.workers.get(key); if (entry) { entry.busy = false; entry.idleAt = Date.now(); } }
      else this.workers.delete(key);
      this.active.delete(job.run.id); this.schedule();
    }
  }
  private engineEvent(event: EngineEvent) {
    if (!event.runId) {
      const cached = this.workers.get(event.conversationId);
      if (event.type === 'error' && cached && !cached.busy && !cached.retiring) {
        cached.retiring = cached.worker.close(true).then(() => { this.workers.delete(event.conversationId); this.schedule(); }, () => this.storageFailure());
      }
      return;
    }
    const job = this.active.get(event.runId); if (!job) return;
    try {
      if (event.type === 'status' && event.payload.state === 'accepted') {
        const run = this.getRun(job.run.appId, job.run.conversationId, job.run.id);
        if (run.state === 'starting') job.run = this.change(run, 'running');
      }
      if (this.failed) return;
      let payload = event.payload, type = `engine.${event.type}`;
      let bytes = Buffer.byteLength(JSON.stringify(payload));
      if (['assistant.delta','tool.result'].includes(event.type)) {
        job.outputBytes = (job.outputBytes ?? 0) + bytes;
        if (bytes > 64*1024 || job.outputBytes > 1024*1024) {
          if (job.truncated) return;
          job.truncated=true; type='engine.output.truncated';
          payload={ source:event.type,originalBytes:bytes,retention:'session_unverified',fullOutputFile:null };
          bytes=256;
        }
      }
      this.pending.push({ run: job.run, type, payload }); this.pendingBytes += bytes;
      if (this.pending.length >= 128 || this.pendingBytes >= 256 * 1024) this.flush();
    } catch { this.storageFailure(); }
  }
  private policyEvent = (event: RunEvent) => {
    const job = this.active.get(event.runId); if (!job) return;
    try {
      const run = this.getRun(job.run.appId, job.run.conversationId, job.run.id);
      if (event.type === 'policy.waiting' && run.state === 'running') job.run = this.change(run, 'waiting_approval');
      if (event.type === 'policy.resolved') {
        const state = (event.payload as { state: string }).state;
        if (['denied','expired','cancelled'].includes(state) && run.state !== 'cancelling') this.cancel(run);
        else if (state === 'consumed' && run.state === 'waiting_approval') job.run = this.change(run, 'running');
      }
    } catch { this.storageFailure(); }
  };
  private flush() {
    if (!this.pending.length) return;
    this.storage.transaction(() => { for (const item of this.pending) {
      this.storage.appendEvent(item.run.appId, item.run.id, item.type, item.payload);
      if (item.type === 'engine.tool.result') {
        const payload = item.payload as { callId?: string; name?: string; result?: unknown; isError?: boolean };
        this.storage.messages.insert({ id: id<'message'>(payload.callId ? projectionId(item.run.id,'tool:'+payload.callId):randomUUID()), appId:item.run.appId,conversationId:item.run.conversationId,
          runId:item.run.id,role:'tool',content:displayText(`${payload.name ?? '工具'}\n${JSON.stringify(payload.result)}`),status:payload.isError ? 'failed' : 'complete',createdAt:timestamp() });
      }
    } });
    this.pending = []; this.pendingBytes = 0;
  }
  private finish(run: Run, state: RunState, error: string | null = null, content = '', result?: EngineResult,project = false) {
    if (this.failed) return;
    this.flush();
    this.storage.transaction(() => {
      const current = this.getRun(run.appId, run.conversationId, run.id);
      if (terminal(current)) return;
      let output: { source:string;truncated:boolean }={ source:'unavailable',truncated:content.length>65536 };
      if (project) {
        const repair=this.recovery.repair(run);
        output={ source:repair.source,truncated:repair.truncated };
        if (repair.status === 'session_invalid' && state === 'succeeded') { state='interrupted';error='SESSION_INVALID'; }
        if (!['no_boundary','no_session'].includes(repair.status)) content='';
      }
      this.storage.transitionRun(run.appId, run.id, current.version, state, timestamp(), error, result?.usage ?? null);
      if (content) this.storage.messages.insert({ id: id<'message'>(randomUUID()), appId: run.appId, conversationId: run.conversationId,
        runId: run.id, role: 'assistant', content:displayText(content), status: 'complete', createdAt: timestamp() });
      this.storage.appendEvent(run.appId, run.id, 'run.completed', { state, error, output,exitCode:result?.exitCode ?? null,cancellation: result?.cancellation ?? null });
    });
    this.log.write(this.getRun(run.appId,run.conversationId,run.id));
  }
  private storageFailure() {
    this.failed = true;
    this.pending=[]; this.pendingBytes=0; this.queue=[];
    for (const job of this.active.values()) { job.controller.abort(); try { this.services.policy.cancel(job.run.id); } catch { /* storage already failed */ } void job.worker?.close(true).catch(() => {}); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; clearInterval(this.timer);
    this.closing = (async () => {
      if (!this.failed) for (const job of [...this.queue, ...this.active.values()]) this.cancel(this.getRun(job.run.appId, job.run.conversationId, job.run.id));
      await Promise.all([...this.active.values()].map(job => job.done));
      await Promise.all([...this.workers.values()].map(entry => entry.retiring ?? entry.worker.close(true)));
      this.flush(); this.workers.clear(); this.subscriptions.clear(); this.services.policy.off('event', this.policyEvent);
    })();
    return this.closing;
  }
}
