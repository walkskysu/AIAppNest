import { parentPort, workerData } from 'node:worker_threads';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import type { ProviderRuntime } from './runtime';
import type { ProbeCode } from '@aiappnest/contracts';

const runtime = workerData as ProviderRuntime & { extraction?:{system:string;text:string;maxTokens:number} };
const nativeFetch = globalThis.fetch;
let status = 0;
let validFinish = false;
let done = false;
let complete = false;
let lengthFinish = false;
let protocolFailure = false;
// Only this dedicated worker gets the bounded, redirect-denying transport. No shared globals or credentials.
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, { ...init, redirect: 'error' });
  status = response.status;
  if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP_ERROR'); }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    protocolFailure = true; await response.body?.cancel(); throw new Error('PROTOCOL_ERROR');
  }
  let bytes = 0;
  let pending = '';
  let data: string[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fail = () => { protocolFailure = true; throw new Error('PROTOCOL_ERROR'); };
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join('\n'); data = [];
    if (done) return fail();
    if (raw === '[DONE]') { done = true; return; }
    let event;
    try { event = JSON.parse(raw); } catch { return fail(); }
    if (!event || event.error || !Array.isArray(event.choices)) return fail();
    // Usage-only chunks may follow the final choice.
    if (event.choices.length === 0) { if (!event.usage) fail(); return; }
    if (event.choices.length !== 1 || validFinish || lengthFinish) return fail();
    const choice = event.choices[0];
    if (choice.index !== 0 || !choice.delta || typeof choice.delta !== 'object' ||
        choice.delta.tool_calls || choice.delta.function_call) return fail();
    if (choice.delta.content != null && typeof choice.delta.content !== 'string') return fail();
    if (choice.finish_reason != null) {
      if (choice.finish_reason === 'stop') validFinish = true;
      else if (choice.finish_reason === 'length') lengthFinish = true;
      else fail();
    }
  };
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.length;
      if (bytes > 65536) { protocolFailure = true; throw new Error('RESPONSE_LIMIT'); }
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n'); pending = lines.pop()!;
      for (const raw of lines) {
        const entry = raw.replace(/\r$/, '');
        if (entry === '') dispatch();
        else if (entry.startsWith('data:')) data.push(entry.slice(5).replace(/^ /, ''));
        else if (!entry.startsWith(':') && !/^(event|id|retry):/.test(entry)) fail();
      }
      controller.enqueue(chunk);
    },
    flush() {
      pending += decoder.decode();
      if (pending.trim() || data.length || !done) fail();
      complete = true;
    },
  }));
  return new Response(body, { status, headers: response.headers });
};

async function run() {
  let code: ProbeCode = 'PROTOCOL_ERROR';
  let extracted:string|undefined;
  try {
    const message = await streamOpenAICompletions(runtime.model, {
      ...(runtime.extraction ? {systemPrompt:runtime.extraction.system} : {}),
      messages: [{ role: 'user', content: runtime.extraction?.text ?? 'Reply with OK.', timestamp: Date.now() }],
    }, {
      apiKey: runtime.apiKey, maxTokens: runtime.extraction?.maxTokens ?? (runtime.providerType === 'deepseek' ? 128 : 16), maxRetries: 0, timeoutMs: runtime.timeoutMs,
      // Pi 0.73.1 supports onPayload before SDK serialization. reasoning:false alone
      // does not emit DeepSeek's switch. This fixed adapter is not a user field bag.
      onPayload: runtime.providerType === 'deepseek'
        ? payload => ({ ...payload as Record<string, unknown>, thinking: { type: 'disabled' } }) : undefined,
      cacheRetention: 'none', signal: AbortSignal.timeout(runtime.timeoutMs),
      // OpenAI SDK's nullable header explicitly removes its default Authorization header.
      headers: runtime.authMode === 'none' ? { Authorization: null as unknown as string } : undefined,
    }).result();
    if (!protocolFailure && complete && done && validFinish && message.stopReason === 'stop' && message.content.some(c => c.type === 'text' && c.text.trim()) && message.content.every(c => c.type === 'text')) code = 'SUCCESS';
    else if (!protocolFailure && complete && done && lengthFinish) code = 'INCOMPLETE_RESPONSE';
    else if (!status) code = 'NETWORK_ERROR';
    if(code==='SUCCESS' && runtime.extraction) {
      extracted=message.content.filter(c=>c.type==='text').map(c=>c.text).join('');
      if(Buffer.byteLength(extracted)>8192) {extracted=undefined;code='PROTOCOL_ERROR';}
    }
  } catch { code = status ? 'PROTOCOL_ERROR' : 'NETWORK_ERROR'; }
  if (status === 401 || status === 403) code = 'AUTH_FAILED';
  else if (status === 402 && runtime.providerType === 'deepseek') code = 'QUOTA_EXCEEDED';
  else if (status === 404) code = 'MODEL_NOT_FOUND';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status >= 500) code = 'NETWORK_ERROR';
  parentPort!.postMessage(runtime.extraction ? (code==='SUCCESS' ? {ok:true,text:extracted} : {ok:false}) : code);
}
void run();
