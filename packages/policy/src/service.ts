import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { dirname, isAbsolute } from 'node:path';
import { closeSync, fstatSync, ftruncateSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { id, type AppConfig } from '@aiappnest/domain';
import type { Storage } from '@aiappnest/storage';
import { approvalSchema, grantSchema, policyHostRequestSchema, policyHostReplySchema, publicError,
  type AppRevisionView, type PolicyApproval, type PolicyGrant, type PolicyHostReply, type PolicyRequest, type PolicyReply, type Result } from '@aiappnest/contracts';
import { canonicalDirectory, checkedTarget, deny, PolicyDenied, within } from './paths';

const scopeSchema = z.strictObject({ appId: z.uuid(), conversationId: z.uuid() });
type Scope = z.infer<typeof scopeSchema>;
const trustSchema = z.strictObject({ ...scopeSchema.shape, id: z.uuid(), revisionId: z.uuid(), version: z.number().int().positive(), revoked: z.boolean() });
const fileArgs = z.strictObject({ grantId: z.uuid(), path: z.string().min(1).max(4096) });
const writeArgs = fileArgs.extend({ content: z.string().max(1024 * 1024) });
const controlled = ['platform_read', 'platform_list', 'platform_write', 'platform_output'] as const;
type ControlledTool = typeof controlled[number];
type Call = { callId: string; tool: string; args: unknown; digest: string; resource: string; grantId: string | null; grantVersion: number | null };
type RunPolicy = Scope & { runId: string; revisionId: string; permissions: AppConfig['permissions']; grants: PolicyGrant[];
  trustVersion: number | null; used: Set<string>; cancelled: boolean };
export interface RunBoundary {
  readonly tools: readonly string[];
  readonly mode: AppConfig['permissions']['mode'];
  read(callId: string, args: unknown, signal?: AbortSignal): Promise<string>;
  list(callId: string, args: unknown, signal?: AbortSignal): Promise<string[]>;
  write(callId: string, args: unknown, signal?: AbortSignal): Promise<string>;
  output(callId: string, args: unknown, signal?: AbortSignal): Promise<string>;
  /** Internal adapter only. Never exposed as renderer/model IPC. */
  trusted<T>(callId: string, tool: string, args: unknown, execute: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  assertActive(): void;
  reject(tool: string, callId: string): void;
  cancel(): void;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** All authority comes from the private host, immutable revisions and database ownership. */
export class PolicyService extends EventEmitter {
  private selections = new Map<string, Scope & { owner: string; root: string; expiresAt: number }>();
  private runs = new Map<string, RunPolicy>();
  private reserved = new Map<string, RunBoundary>();
  private waiting = new Map<string, { finish: () => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly storage: Storage, private readonly revision: (appId: string, revisionId: string) => AppRevisionView,
    private readonly options: { now?: () => number; approvalMs?: number } = {}) {
    super(); this.now = options.now ?? Date.now;
    // Restart cannot resume old calls or turn persisted approvals into new authority.
    for (const raw of storage.policyRecords('approval')) {
      const item = approvalSchema.parse(JSON.parse(raw));
      if (item.state === 'pending' || item.state === 'allowed') this.setApproval(item, 'cancelled');
    }
  }
  private scope(scope: Scope) {
    scopeSchema.parse(scope);
    const conversation = this.storage.conversations.get({ appId: id<'app'>(scope.appId), id: id<'conversation'>(scope.conversationId) });
    if (conversation.status !== 'active' || this.storage.apps.get({ id: conversation.appId }).status === 'archived') deny('INACTIVE_SCOPE');
    return conversation;
  }
  private permissions(scope: Scope) {
    const conversation = this.scope(scope), revision = this.revision(scope.appId, conversation.revisionId);
    if (revision.appId !== scope.appId || revision.id !== conversation.revisionId || revision.snapshot.runtimeVersion !== '0.73.1') deny('INVALID_SNAPSHOT');
    const permissions = revision.snapshot.config.permissions;
    if ((permissions.mode === 'chat' && permissions.tools.length) || (permissions.mode !== 'trusted-automation' && permissions.tools.includes('shell'))) deny('INVALID_SNAPSHOT');
    return { revisionId: conversation.revisionId, permissions: structuredClone(permissions) };
  }
  private grants(scope: Scope): PolicyGrant[] { return this.storage.policyRecords('grant', scope.appId, scope.conversationId).map(raw => grantSchema.parse(JSON.parse(raw))); }
  private approvals(scope: Scope): PolicyApproval[] { return this.storage.policyRecords('approval', scope.appId, scope.conversationId).map(raw => approvalSchema.parse(JSON.parse(raw))); }
  private trust(scope: Scope) { return this.storage.policyRecords('trust', scope.appId, scope.conversationId).map(raw => trustSchema.parse(JSON.parse(raw)))[0]; }
  private setApproval(item: PolicyApproval, state: PolicyApproval['state']): void {
    const next = { ...item, state };
    this.storage.savePolicyRecord('approval', next);
    const event = this.storage.appendEvent(id<'app'>(item.appId), id<'run'>(item.runId), state === 'pending' ? 'policy.waiting' : 'policy.resolved', next);
    for (const listener of this.listeners('event')) { try { listener(event); } catch { /* isolate subscribers */ } }
    if (state !== 'pending') {
      const waiting = this.waiting.get(item.id);
      if (waiting) { clearTimeout(waiting.timer); this.waiting.delete(item.id); waiting.finish(); }
    }
  }
  private audit(run: RunPolicy, call: Pick<Call, 'callId' | 'tool' | 'resource'>, allowed: boolean, reason: string): void {
    this.storage.appendEvent(id<'app'>(run.appId), id<'run'>(run.runId), 'policy.decision', {
      appId: run.appId, conversationId: run.conversationId, runId: run.runId,
      callId: call.callId, tool: call.tool, resource: call.resource, allowed, reason,
    });
  }
  request(raw: unknown): Result<PolicyHostReply> {
    const parsed = policyHostRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    try {
      if (this.closed) deny('SERVICE_CLOSED');
      const input = parsed.data;
      let reply: PolicyHostReply;
      if (input.operation === 'request') reply = { operation: 'request', reply: this.dispatch(input.owner, input.request) };
      else {
        const scope = { appId: input.appId, conversationId: input.conversationId }, snapshot = this.permissions(scope);
        if (input.operation === 'select') {
          for (const [key, value] of this.selections) if (value.expiresAt <= this.now()) this.selections.delete(key);
          if (this.selections.size >= 64) deny('SELECTION_LIMIT');
          const token = randomUUID(), expiresAt = this.now() + 300000;
          this.selections.set(token, { ...scope, owner: input.owner, root: canonicalDirectory(input.path), expiresAt });
          reply = { operation: 'select', selection: { token, expiresAt, scope: 'policy-directory' } };
        } else {
          if (snapshot.permissions.mode !== 'trusted-automation') deny('MODE_DENIED');
          const previous = this.trust(scope);
          this.storage.savePolicyRecord('trust', { ...scope, id: scope.conversationId, revisionId: snapshot.revisionId, version: (previous?.version ?? 0) + 1, revoked: false });
          reply = { operation: 'trust' };
        }
      }
      return { ok: true, value: policyHostReplySchema.parse(reply) };
    } catch (error) {
      return { ok: false, error: publicError(error instanceof z.ZodError ? 'INVALID_INPUT' : 'FORBIDDEN') };
    }
  }
  private dispatch(owner: string, input: PolicyRequest): PolicyReply {
    const scope = { appId: input.appId, conversationId: input.conversationId }, snapshot = this.permissions(scope);
    if (input.operation === 'grants.list') return { operation: input.operation, grants: this.grants(scope) };
    if (input.operation === 'grants.create') {
      if (snapshot.permissions.mode !== 'controlled-files' || !snapshot.permissions.tools.includes(input.access)) deny('CAPABILITY_DENIED');
      let root: string;
      if (input.resource === 'external') {
        const selection = input.token && this.selections.get(input.token);
        if (!selection || selection.owner !== owner || selection.appId !== scope.appId || selection.conversationId !== scope.conversationId || selection.expiresAt <= this.now()) deny('INVALID_SELECTION');
        root = canonicalDirectory(selection.root); this.selections.delete(input.token!);
        // File tools must not rewrite their own authority, credentials or executable code.
        const protectedRoots = [this.storage.paths.root, dirname(process.execPath)];
        if (process.argv[1] && isAbsolute(process.argv[1])) protectedRoots.push(dirname(process.argv[1]));
        if (protectedRoots.some(path => { const protectedRoot = canonicalDirectory(path); return within(root, protectedRoot) || within(protectedRoot, root); })) deny('PLATFORM_RESOURCE');
      } else {
        if (input.token) deny('INVALID_SELECTION');
        root = this.storage.paths.conversation(id<'app'>(scope.appId), id<'conversation'>(scope.conversationId), input.resource === 'workspace' ? 'workspace' : 'artifacts');
        this.storage.paths.ensureDirectory(root); root = canonicalDirectory(root);
      }
      const grant: PolicyGrant = { id: randomUUID(), ...scope, revisionId: snapshot.revisionId, resource: input.resource, root,
        access: input.access, confirmation: input.confirmation, version: 1, revoked: false, createdAt: this.now() };
      this.storage.savePolicyRecord('grant', grant);
      return { operation: input.operation, grant };
    }
    if (input.operation === 'grants.revoke') {
      const grant = this.grants(scope).find(g => g.id === input.grantId);
      if (!grant || grant.version !== input.expectedVersion) deny('GRANT_VERSION');
      const next = { ...grant, revoked: true, version: grant.version + 1 };
      this.storage.savePolicyRecord('grant', next);
      for (const item of this.approvals(scope)) if (item.grantId === grant.id && ['pending', 'allowed'].includes(item.state)) this.setApproval(item, 'cancelled');
      return { operation: input.operation, grant: next };
    }
    if (input.operation === 'trust.revoke') {
      const trust = this.trust(scope);
      if (trust) this.storage.savePolicyRecord('trust', { ...trust, revoked: true, version: trust.version + 1 });
      for (const run of this.runs.values()) if (run.appId === scope.appId && run.conversationId === scope.conversationId) this.cancel(run.runId);
      return { operation: input.operation };
    }
    const record = this.storage.runs.get({ appId: id<'app'>(scope.appId), id: id<'run'>(input.runId) });
    if (record.conversationId !== scope.conversationId) deny('OWNERSHIP_MISMATCH');
    for (const item of this.approvals(scope)) if (item.runId === input.runId && ['pending', 'allowed'].includes(item.state) && item.expiresAt <= this.now()) this.setApproval(item, 'expired');
    if (input.operation === 'approvals.list') return { operation: input.operation, approvals: this.approvals(scope).filter(a => a.runId === input.runId) };
    const item = this.approvals(scope).find(a => a.id === input.approvalId && a.runId === input.runId), run = this.runs.get(input.runId);
    if (!item || item.state !== 'pending' || item.digest !== input.digest || !run) deny('APPROVAL_BINDING');
    this.active(run);
    const state = input.decision === 'allow' ? 'allowed' : 'denied'; this.setApproval(item, state);
    return { operation: input.operation, approval: { ...item, state } };
  }
  /** Scheduler/test host only: resolve run -> conversation -> fixed revision. */
  bindRun(appId: string, runId: string): RunBoundary {
    const reserved = this.reserved.get(runId);
    if (reserved) {
      if (this.runs.get(runId)?.appId !== appId) deny('OWNERSHIP_MISMATCH');
      reserved.assertActive(); this.reserved.delete(runId); return reserved;
    }
    if (this.closed || this.runs.has(runId)) deny('RUN_ALREADY_BOUND');
    const record = this.storage.runs.get({ appId: id<'app'>(appId), id: id<'run'>(runId) });
    const scope = { appId, conversationId: record.conversationId }, snapshot = this.permissions(scope), trust = this.trust(scope);
    if (snapshot.permissions.mode === 'trusted-automation' && (!trust || trust.revoked || trust.revisionId !== snapshot.revisionId)) deny('EXPLICIT_TRUST_REQUIRED');
    const run: RunPolicy = { ...scope, runId, ...snapshot, grants: this.grants(scope).filter(g => !g.revoked && g.revisionId === snapshot.revisionId),
      trustVersion: trust?.version ?? null, used: new Set(), cancelled: false };
    this.active(run); this.runs.set(runId, run);
    const tools: string[] = snapshot.permissions.mode === 'chat' ? [] : snapshot.permissions.mode === 'controlled-files'
      ? controlled.filter(tool => snapshot.permissions.tools.includes(tool === 'platform_read' || tool === 'platform_list' ? 'read' : 'write'))
      : [...(snapshot.permissions.tools.includes('read') ? ['read', 'grep', 'find', 'ls'] : []),
        ...(snapshot.permissions.tools.includes('write') ? ['write', 'edit'] : []), ...(snapshot.permissions.tools.includes('shell') ? ['bash'] : [])];
    return Object.freeze({ tools: Object.freeze(tools), mode: snapshot.permissions.mode,
      read: (callId: string, args: unknown, signal?: AbortSignal) => this.file(run, 'platform_read', callId, args, signal) as Promise<string>,
      list: (callId: string, args: unknown, signal?: AbortSignal) => this.file(run, 'platform_list', callId, args, signal) as Promise<string[]>,
      write: (callId: string, args: unknown, signal?: AbortSignal) => this.file(run, 'platform_write', callId, args, signal) as Promise<string>,
      output: (callId: string, args: unknown, signal?: AbortSignal) => this.file(run, 'platform_output', callId, args, signal) as Promise<string>,
      trusted: async <T>(callId: string, tool: string, args: unknown, execute: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
        const call = this.call(run, callId, tool, structuredClone(args), 'account-process', null);
        try {
          if (run.permissions.mode !== 'trusted-automation' || !tools.includes(tool)) deny('TOOL_DENIED');
          const approval = await this.confirm(run, call, signal);
          this.finalCheck(run, call, approval, signal);
          this.audit(run, call, true, 'EXPLICIT_TRUST_AND_CONFIRMATION');
          return await execute();
        } catch (error) { this.audit(run, call, false, this.reason(error)); throw new PolicyDenied(this.reason(error)); }
      },
      assertActive: () => this.active(run),
      reject: (tool: string, callId: string) => { this.audit(run, { tool: [...controlled, 'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'delete', 'rename'].includes(tool) ? tool : 'unlisted', callId: callId.slice(0, 200), resource: 'none' }, false, 'TOOL_DENIED'); },
      cancel: () => this.cancel(runId),
    });
  }
  private active(run: RunPolicy): void {
    if (this.closed || run.cancelled) deny('RUN_CANCELLED');
    const current = this.storage.runs.get({ appId: id<'app'>(run.appId), id: id<'run'>(run.runId) });
    if (!['starting', 'running', 'waiting_approval'].includes(current.state)) deny('RUN_INACTIVE');
    if (run.permissions.mode === 'trusted-automation') {
      const trust = this.trust(run);
      if (!trust || trust.revoked || trust.version !== run.trustVersion || trust.revisionId !== run.revisionId) deny('TRUST_REVOKED');
    }
  }
  private call(run: RunPolicy, callId: string, tool: string, args: unknown, resource: string, grant: PolicyGrant | null): Call {
    if (!z.string().min(1).max(200).safeParse(callId).success || run.used.has(callId)) deny('CALL_REPLAY');
    run.used.add(callId);
    return { callId, tool, args, resource, grantId: grant?.id ?? null, grantVersion: grant?.version ?? null,
      digest: digest({ appId: run.appId, conversationId: run.conversationId, runId: run.runId, callId, tool, args }) };
  }
  private currentGrant(run: RunPolicy, call: Call): PolicyGrant {
    const grant = this.grants(run).find(g => g.id === call.grantId), bound = run.grants.find(g => g.id === call.grantId);
    if (!grant || !bound || grant.revoked || grant.version !== call.grantVersion || canonicalJson(grant) !== canonicalJson(bound)) deny('GRANT_REVOKED');
    return grant;
  }
  private async confirm(run: RunPolicy, call: Call, signal?: AbortSignal): Promise<string> {
    this.active(run); if (signal?.aborted) deny('RUN_CANCELLED');
    const item: PolicyApproval = { id: randomUUID(), appId: run.appId, conversationId: run.conversationId, runId: run.runId,
      callId: call.callId, tool: call.tool, digest: call.digest, grantId: call.grantId, grantVersion: call.grantVersion,
      resource: call.resource, state: 'pending', createdAt: this.now(), expiresAt: this.now() + (this.options.approvalMs ?? 120000) };
    let finish!: () => void;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    const timer = setTimeout(() => {
      const current = this.approvals(run).find(a => a.id === item.id);
      if (current && ['pending', 'allowed'].includes(current.state)) this.setApproval(current, 'expired');
    }, Math.max(1, item.expiresAt - this.now())); timer.unref();
    this.waiting.set(item.id, { finish, timer });
    const abort = () => this.cancel(run.runId);
    signal?.addEventListener('abort', abort, { once: true });
    try { this.setApproval(item, 'pending'); await promise; }
    finally { signal?.removeEventListener('abort', abort); clearTimeout(timer); this.waiting.delete(item.id); }
    return item.id;
  }
  private finalCheck(run: RunPolicy, call: Call, approvalId?: string, signal?: AbortSignal): void {
    this.active(run); if (signal?.aborted) deny('RUN_CANCELLED');
    if (call.grantId) this.currentGrant(run, call);
    if (approvalId) {
      const item = this.approvals(run).find(a => a.id === approvalId);
      if (!item || item.runId !== run.runId || item.callId !== call.callId || item.tool !== call.tool || item.digest !== call.digest || item.state !== 'allowed') deny('APPROVAL_DENIED');
      if (item.expiresAt <= this.now()) { this.setApproval(item, 'expired'); deny('APPROVAL_EXPIRED'); }
      this.setApproval(item, 'consumed');
    }
    this.active(run);
    if (call.grantId) this.currentGrant(run, call);
  }
  private reason(error: unknown): string { return error instanceof PolicyDenied ? error.reason : error instanceof z.ZodError ? 'INVALID_ARGUMENTS' : 'FILE_UNAVAILABLE'; }
  private async file(run: RunPolicy, tool: ControlledTool, callId: string, input: unknown, signal?: AbortSignal): Promise<string | string[]> {
    let call: Call = { callId, tool, args: null, digest: '', grantId: null, grantVersion: null, resource: 'unresolved' };
    try {
      this.active(run);
      const write = tool === 'platform_write' || tool === 'platform_output';
      if (run.permissions.mode !== 'controlled-files' || !run.permissions.tools.includes(write ? 'write' : 'read')) deny('TOOL_DENIED');
      const args = (write ? writeArgs : fileArgs).parse(input);
      const grant = run.grants.find(g => g.id === args.grantId);
      if (!grant || grant.access !== (write ? 'write' : 'read')) deny('ACCESS_DENIED');
      if (tool === 'platform_output' && grant.resource !== 'output') deny('OUTPUT_GRANT_REQUIRED');
      call = this.call(run, callId, tool, args, `${grant.resource}:${grant.id}`, grant);
      this.currentGrant(run, call); checkedTarget(grant.root, args.path, write);
      const approval = grant.confirmation === 'always' ? await this.confirm(run, call, signal) : undefined;
      this.finalCheck(run, call, approval, signal);
      const target = checkedTarget(grant.root, args.path, write);
      if (tool === 'platform_list') {
        if (!lstatSync(target.path).isDirectory()) deny('DIRECTORY_REQUIRED');
        this.audit(run, call, true, 'GRANTED');
        return readdirSync(checkedTarget(grant.root, args.path, false).path).slice(0, 1000);
      }
      if (target.exists && !lstatSync(target.path).isFile()) deny('FILE_REQUIRED');
      // Never open with truncation: validate the opened handle before changing bytes.
      const fd = openSync(target.path, write ? tool === 'platform_output' || !target.exists ? 'wx' : 'r+' : 'r');
      try {
        const stat = fstatSync(fd), current = checkedTarget(grant.root, args.path, false), actual = lstatSync(current.path);
        if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== actual.dev || stat.ino !== actual.ino) deny('TARGET_CHANGED');
        this.active(run); this.currentGrant(run, call);
        this.audit(run, call, true, 'GRANTED');
        if (!write) { if (stat.size > 1024 * 1024) deny('FILE_TOO_LARGE'); return readFileSync(fd, 'utf8'); }
        ftruncateSync(fd, 0); writeFileSync(fd, (args as z.infer<typeof writeArgs>).content, 'utf8'); fsyncSync(fd);
        return 'written';
      } finally { closeSync(fd); }
    } catch (error) { this.audit(run, call, false, this.reason(error)); throw new PolicyDenied(this.reason(error)); }
  }
  cancel(runId: string): void {
    const run = this.runs.get(runId); if (!run || run.cancelled || this.closed) return;
    run.cancelled = true;
    for (const item of this.approvals(run)) if (item.runId === runId && ['pending', 'allowed'].includes(item.state)) this.setApproval(item, 'cancelled');
  }
  /** Freeze grant/trust authority before Worker startup; the adapter claims this exact boundary. */
  reserve(appId: string, runId: string): void { this.reserved.set(runId, this.bindRun(appId, runId)); }
  release(runId: string): void { this.cancel(runId); this.reserved.delete(runId); this.runs.delete(runId); }
  close(): void {
    if (this.closed) return;
    for (const runId of this.runs.keys()) this.cancel(runId);
    this.closed = true; this.selections.clear();
  }
}
