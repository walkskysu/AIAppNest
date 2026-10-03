import { parentPort, workerData } from 'node:worker_threads';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import type { ProviderRuntime } from './runtime';
import type { ProbeCode } from '@aiappnest/contracts';

const runtime = workerData as ProviderRuntime;
const nativeFetch = globalThis.fetch;
let status = 0;
let validFinish = false;
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
  let line = '';
  const decoder = new TextDecoder();
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.length;
      if (bytes > 65536) { protocolFailure = true; throw new Error('RESPONSE_LIMIT'); }
      line += decoder.decode(chunk, { stream: true });
      const lines = line.split('\n'); line = lines.pop()!;
      for (const entry of lines) {
        if (!entry.startsWith('data:')) continue;
        const data = entry.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.choices?.[0]?.index === 0 && event.choices[0].finish_reason === 'stop') validFinish = true;
        } catch { protocolFailure = true; }
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status, headers: response.headers });
};

async function run() {
  let code: ProbeCode = 'PROTOCOL_ERROR';
  try {
    const message = await streamOpenAICompletions(runtime.model, {
      messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
    }, {
      apiKey: runtime.apiKey, maxTokens: 16, maxRetries: 0, timeoutMs: runtime.timeoutMs,
      cacheRetention: 'none', signal: AbortSignal.timeout(runtime.timeoutMs),
      // OpenAI SDK's nullable header explicitly removes its default Authorization header.
      headers: runtime.authMode === 'none' ? { Authorization: null as unknown as string } : undefined,
    }).result();
    if (!protocolFailure && validFinish && message.stopReason === 'stop' && message.content.some(c => c.type === 'text' && c.text.trim()) && message.content.every(c => c.type === 'text')) code = 'SUCCESS';
    else if (!status) code = 'NETWORK_ERROR';
  } catch { code = status ? 'PROTOCOL_ERROR' : 'NETWORK_ERROR'; }
  if (status === 401 || status === 403) code = 'AUTH_FAILED';
  else if (status === 404) code = 'MODEL_NOT_FOUND';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status >= 500) code = 'NETWORK_ERROR';
  parentPort!.postMessage(code);
}
void run();
