// Deterministic provider fixture, NOT a real model. Runs inside the real Pi tool/session loop.
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';

export default function (pi) {
  pi.registerProvider('spike-fixture', {
    baseUrl: 'http://unused.invalid', apiKey: 'non-secret-fixture', api: 'spike-fixture-api',
    models: [{ id: 'fixture', name: 'Deterministic fixture (not a model)', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const last = context.messages.at(-1);
        const textOf = (message) => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
        const text = textOf(last);
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
          content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now() };
        if (text === 'model-error') { message.stopReason = 'error'; message.errorMessage = 'Fixture model failure'; }
        else if (last?.role !== 'toolResult' && text.startsWith('tool:')) {
          const input = JSON.parse(text.slice(5)); message.stopReason = 'toolUse';
          message.content = [{ type: 'toolCall', id: `fixture-${Date.now()}`, name: input.name, arguments: input.args }];
        } else {
          let answer = `你好 🌏 ${text}`;
          if (text === 'recall') answer = context.messages.filter(m => m.role === 'user').map(textOf).join('\n');
          if (text.includes('SKILL_')) answer = text.match(/SKILL_[A-Za-z0-9_-]+/)?.[0] ?? 'missing';
          message.content = [{ type: 'text', text: answer }];
        }
        if (options?.signal?.aborted) message.stopReason = 'aborted';
        stream.push({ type: 'start', partial: message });
        if (message.stopReason === 'error' || message.stopReason === 'aborted') stream.push({ type: 'error', reason: message.stopReason, error: message });
        else stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    }
  });
}
