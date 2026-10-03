import type { Model } from '@mariozechner/pi-ai';
import type { ProviderConfig } from '@aiappnest/contracts';

/** Trusted service/worker only: never serialize this object into IPC replies or logs. */
export interface ProviderRuntime {
  model: Model<'openai-completions'>;
  apiKey: string;
  authMode: ProviderConfig['authMode'];
  timeoutMs: number;
  env: Record<string, string>;
}
export function buildRuntime(config: ProviderConfig, key: string | undefined, base: NodeJS.ProcessEnv = process.env): ProviderRuntime {
  const env: Record<string, string> = {};
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (base[name]) env[name] = base[name];
  if (config.authMode === 'api-key') {
    if (!key) throw new Error('CREDENTIAL_UNAVAILABLE');
    env.AIAPPNEST_MODEL_API_KEY = key;
  }
  return {
    model: { id: config.modelId, name: config.modelId, api: 'openai-completions', provider: 'aiappnest',
      baseUrl: config.endpoint, reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
        supportsUsageInStreaming: true, maxTokensField: 'max_tokens', sendSessionAffinityHeaders: false },
    },
    // A non-secret placeholder prevents the SDK falling back to process.env for no-auth local services.
    apiKey: config.authMode === 'api-key' ? key! : 'aiappnest-no-auth', authMode: config.authMode,
    timeoutMs: config.settings.timeoutMs, env,
  };
}
