import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { RunBoundary } from '../../policy/src/service';
import { policyExtension } from './policy-extension';
import { JsonlDecoder } from './jsonl';
import { ENGINE_VERSION } from './types';

/** The only production extension. No user supplied code/configuration is loaded here. */
export default async function platformExtension(pi: ExtensionAPI): Promise<void> {
  const config = JSON.parse(readFileSync(process.env.AIAPPNEST_ENGINE_CONFIG!, 'utf8'));
  if (JSON.stringify(config.versions) !== JSON.stringify(ENGINE_VERSION)) throw new Error('VERSION_MISMATCH');
  const socket = connect(process.env.AIAPPNEST_POLICY_PIPE!);
  let alive = true;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let ready!: () => void, failed!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const fail = () => {
    alive = false; failed(new Error('POLICY_DISCONNECTED'));
    for (const item of pending.values()) item.reject(new Error('POLICY_DISCONNECTED'));
    pending.clear(); socket.destroy();
  };
  const decoder = new JsonlDecoder(value => {
    if (value.type === 'ready') { ready(); return; }
    const item = pending.get(value.id);
    if (!item || value.type !== 'result') { fail(); return; }
    pending.delete(value.id);
    if (value.ok === true) item.resolve(value.result); else item.reject(new Error('POLICY_DENIED'));
  }, 2 * 1024 * 1024);
  socket.on('data', chunk => { try { decoder.push(chunk); } catch { fail(); } });
  socket.on('error', fail); socket.on('close', fail);
  socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', token: process.env.AIAPPNEST_POLICY_TOKEN }) + '\n'));
  const timer = setTimeout(fail, 10000);
  try { await connected; } finally { clearTimeout(timer); }
  const call = (method: string, callId: string, args: unknown, tool?: string): Promise<any> => {
    if (!alive || pending.size >= 16) return Promise.reject(new Error('POLICY_DISCONNECTED'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject }); socket.write(JSON.stringify({ type: 'call', id, method, callId, args, tool }) + '\n');
    });
  };
  const boundary: RunBoundary = {
    mode: config.mode, tools: config.tools,
    assertActive() { if (!alive) throw new Error('POLICY_DISCONNECTED'); },
    read: (id, args) => call('read', id, args), list: (id, args) => call('list', id, args),
    write: (id, args) => call('write', id, args), output: (id, args) => call('output', id, args),
    async trusted(id, tool, args, execute, signal) {
      await call('trusted', id, args, tool);
      if (!alive || signal?.aborted) throw new Error('POLICY_CANCELLED');
      return execute();
    },
    reject(tool, id) { void call('reject', id, {}, tool).catch(() => {}); },
    cancel: fail,
  };
  const guard = policyExtension(boundary, process.cwd());
  await guard.extension(pi);
  const model = config.model;
  pi.registerProvider('aiappnest', {
    baseUrl: model.baseUrl, apiKey: 'AIAPPNEST_MODEL_API_KEY', api: 'openai-completions',
    models: [model],
    streamSimple(selected, context, options) {
      return streamOpenAICompletions(selected as any, context, { ...options, apiKey: process.env.AIAPPNEST_MODEL_API_KEY,
        maxTokens: model.maxTokens, temperature: config.temperature, maxRetries: 0, timeoutMs: config.timeoutMs,
        cacheRetention: 'none',
        headers: config.authMode === 'none' ? { Authorization: null as unknown as string } : undefined,
        onPayload: config.providerType === 'deepseek' ? payload => ({ ...payload as object, thinking: { type: 'disabled' } }) : undefined,
      });
    },
  });
  pi.on('session_start', (_event, ctx) => {
    if (!guard.ready()) throw new Error('EXTENSION_NOT_READY');
    if (JSON.stringify([...pi.getActiveTools()].sort()) !== JSON.stringify([...config.tools].sort())) throw new Error('ACTIVE_TOOL_MISMATCH');
    if (pi.getAllTools().some(tool => tool.sourceInfo.source === 'builtin')) throw new Error('BUILTIN_PRESENT');
    ctx.ui.notify('AIAPPNEST_READY_V1', 'info');
  });
  // Host-only numeric budget probe; never exposes prompt content over notifications.
  pi.registerCommand('aiappnest-memory-budget', { handler: async (_args, ctx) => {
    await ctx.waitForIdle();
    const tools = pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name));
    const overhead = Buffer.byteLength(ctx.getSystemPrompt()) + Buffer.byteLength(JSON.stringify(tools)) + 4096;
    const remaining = Math.max(0,(ctx.model?.contextWindow ?? 0) - model.maxTokens - overhead);
    ctx.ui.notify('AIAPPNEST_MEMORY_BUDGET_V1:' + remaining, 'info');
  } });
  pi.registerCommand('aiappnest-barrier', { handler: async (_args, ctx) => {
    await ctx.waitForIdle();
    if (!guard.ready()) throw new Error('EXTENSION_FAILED');
  } });
  // Supported Pi extension API writes a metadata entry; it never becomes a user/model message.
  pi.registerCommand('aiappnest-run-boundary', { handler: async (args,ctx) => {
    await ctx.waitForIdle();
    const [runId,inputHash]=args.split(' ');
    if (!/^[0-9a-f-]{36}$/.test(runId ?? '') || !/^[0-9a-f]{64}$/.test(inputHash ?? '')) throw new Error('INVALID_BOUNDARY');
    pi.appendEntry('aiappnest-run',{ runId,inputHash });
  } });
  // Explicit no-execution command. Other extension commands cannot enter via public prompt.
  pi.registerCommand('aiappnest-handled', { handler: async (_args, ctx) => { ctx.ui.notify('AIAPPNEST_HANDLED_V1', 'info'); } });
  pi.on('session_shutdown', () => { alive = false; socket.destroy(); });
}
