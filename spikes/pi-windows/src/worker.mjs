import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { spawnJob } from './native.mjs';
import { launchArgs, workerEnv } from './config.mjs';
import { JsonlDecoder } from './jsonl.mjs';

export class Worker {
  pending = new Map(); events = []; audit = []; sequence = 0; busy = false; fatal = null;
  stderrBytes = 0; closed = false; cancelled = false;
  static async start(config, options = {}) {
    const args = await launchArgs(config, options);
    const worker = new Worker(config, spawnJob(process.execPath, args, {
      cwd: config.cwd, env: workerEnv(config, options.credentials), stdio: ['pipe', 'pipe', 'pipe'],
    }));
    try {
      const state = (await worker.command('get_state')).data;
      const expectedProvider = options.fixture ? 'spike-fixture' : options.provider;
      const expectedModel = options.fixture ? 'fixture' : options.model;
      if (state.model?.provider !== expectedProvider || state.model?.id !== expectedModel) throw new Error('Exact model mismatch');
      if (options.sessionFile && await realpath(state.sessionFile) !== await realpath(options.sessionFile)) throw new Error('Session mismatch');
      const commands = (await worker.command('get_commands')).data.commands;
      if (!commands.some(c => c.name === 'spike-barrier')) throw new Error('Policy extension did not load');
      worker.sessionFile = state.sessionFile; return worker;
    } catch (e) { await worker.close(); throw e; }
  }
  constructor(config, child) {
    this.config = config; this.child = child;
    const decoder = new JsonlDecoder(value => this.receive(value));
    child.stdout.on('data', chunk => { try { decoder.push(chunk); } catch { this.fail(new Error('Invalid RPC JSONL')); } });
    child.stdout.on('end', () => { try { decoder.end(); } catch { this.fail(new Error('Truncated RPC JSONL')); } });
    // Never persist raw stdout/stderr/model text: keys can be echoed or fragmented across chunks.
    child.stderr.on('data', chunk => { this.stderrBytes += chunk.length; });
    child.stdin.on('error', () => this.fail(new Error('RPC stdin closed')));
    child.on('error', () => this.fail(new Error('Worker spawn failed')));
    this.exit = new Promise(resolve => child.on('close', (code, signal) => {
      this.closed = true; this.fail(new Error('Worker exited'));
      this.audit.push({ seq: ++this.sequence, type: 'process_exit', code, signal }); resolve();
    }));
  }
  receive(value) {
    // Only static metadata is exportable. Do not log arbitrary type/id/error/payload strings.
    this.audit.push({ seq: ++this.sequence, type: knownEvents.has(value.type) ? value.type : 'other',
      ...(value.type === 'response' ? { success: value.success === true, command: this.pending.get(value.id)?.type ?? 'unknown' } : {}),
      ...(value.type === 'tool_execution_end' ? { isError: value.isError === true } : {}),
      ...(value.type === 'message_end' && ['stop', 'toolUse', 'error', 'aborted', 'length'].includes(value.message?.stopReason) ? { stopReason: value.message.stopReason } : {}) });
    if (value.type === 'response') {
      const pending = this.pending.get(value.id);
      if (pending) {
        clearTimeout(pending.timer); this.pending.delete(value.id);
        if (value.success) pending.resolve(value); else pending.reject(new Error(`RPC ${pending.type} rejected`));
      }
    } else this.events.push(value);
  }
  fail(error) {
    const firstFailure = !this.fatal;
    this.fatal ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (firstFailure && !this.closed) this.child.kill();
  }
  command(type, fields = {}, timeout = 15000) {
    if (!['prompt', 'abort', 'get_state', 'get_messages', 'get_commands'].includes(type)) return Promise.reject(new Error('RPC command not allowed'));
    // Diagnostics cannot submit work around run()'s single-run lock.
    if (type === 'prompt' && (this.busy || fields.message !== '/spike-inspect')) return Promise.reject(new Error('Use run() for prompts'));
    return this.#request(type, fields, timeout);
  }
  #request(type, fields = {}, timeout = 15000) {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`RPC ${type} timeout`)), timeout);
      this.pending.set(id, { resolve, reject, timer, type });
      this.child.stdin.write(`${JSON.stringify({ ...fields, type, id })}\n`);
    });
  }
  async until(predicate, timeout = 30000) {
    const end = Date.now() + timeout;
    while (!predicate()) { if (this.fatal) throw this.fatal; if (Date.now() >= end) throw new Error('Run timeout'); await delay(10); }
  }
  async run(message, timeout = 30000) {
    if (this.busy) throw new Error('Worker already has an active run');
    this.busy = true; this.cancelled = false; const start = this.events.length;
    try {
      await this.#request('prompt', { message }, timeout);
      await this.until(() => this.events.slice(start).some(e => e.type === 'agent_end' || (e.type === 'extension_ui_request' && e.message === 'SPIKE_HANDLED')), timeout);
      // Locked configuration: retries/compaction off, no follow-up extensions, no queued prompts.
      await this.#request('prompt', { message: '/spike-barrier' }, timeout);
      const state = (await this.command('get_state')).data;
      if (state.isStreaming || state.isCompacting || state.pendingMessageCount) throw new Error('Engine not idle');
      const messages = (await this.command('get_messages')).data.messages;
      this.sessionFile = state.sessionFile;
      const events = this.events.slice(start);
      const handled = events.some(e => e.type === 'extension_ui_request' && e.message === 'SPIKE_HANDLED');
      const assistant = events.filter(e => e.type === 'message_end' && e.message.role === 'assistant').at(-1)?.message;
      const persisted = messages.at(-1);
      const completed = assistant?.stopReason === 'stop' && isDeepStrictEqual(assistant, persisted);
      const toolError = events.some(e => e.type === 'tool_execution_end' && e.isError);
      const modelError = events.some(e => e.type === 'message_end' && e.message.role === 'assistant' && e.message.stopReason === 'error');
      const status = this.cancelled || assistant?.stopReason === 'aborted' ? 'cancelled'
        : handled ? 'handled' : toolError || modelError || !completed ? 'failed' : 'succeeded';
      return { status, events, messages, state };
    } catch (error) {
      // Uncertain completion is not reusable; terminate the Job before releasing the run lock.
      await this.close(); throw error;
    } finally { this.busy = false; }
  }
  async cancel(timeout = 1500) {
    this.cancelled = true;
    const deadline = Date.now() + timeout;
    try {
      await this.command('abort', {}, timeout);
      // An abort acknowledgment alone does not prove the active run has settled.
      await this.until(() => !this.busy, Math.max(0, deadline - Date.now()));
      if (this.fatal) throw this.fatal;
      return 'cooperative';
    }
    catch { await this.close(true); return 'forced'; }
  }
  async close(force = false) {
    if (this.closed) return;
    if (force) this.child.kill(); else this.child.stdin.end();
    let timer;
    await Promise.race([this.exit, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
    if (!this.closed) { this.child.kill(); await this.exit; }
  }
}
const knownEvents = new Set(['response', 'agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'extension_ui_request', 'extension_error', 'auto_retry_start', 'auto_retry_end', 'auto_compaction_start', 'auto_compaction_end']);
