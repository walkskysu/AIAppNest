import { z } from 'zod';

// No paths, credentials, environment, executable flags or extension entry points.
export const appConfigSchema = z.strictObject({
  schemaVersion: z.literal(2),
  role: z.string().max(24000), outputRequirements: z.string().max(12000), openingMessage: z.string().max(4000),
  model: z.strictObject({ providerProfileId: z.uuid(), expectedRevision: z.number().int().positive(),
    temperature: z.number().min(0).max(2), maxOutputTokens: z.number().int().min(1).max(32768),
  }).nullable(),
  skills: z.array(z.strictObject({ id: z.uuid(), version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })).max(100),
  permissions: z.strictObject({ mode: z.enum(['chat', 'controlled-files', 'trusted-automation']),
    tools: z.array(z.enum(['read', 'write', 'shell'])).max(3),
  }),
  memory: z.strictObject({ enabled: z.boolean(), automaticCandidates: z.boolean(),
    maxItems: z.number().int().min(0).max(100), tokenBudget: z.number().int().min(0).max(32000),
  }),
  execution: z.strictObject({ maxTurns: z.number().int().min(1).max(100), timeoutMs: z.number().int().min(1000).max(3600000) }),
});
export type AppConfig = z.infer<typeof appConfigSchema>;
export const newAppConfig = (): AppConfig => ({ schemaVersion: 2, role: '', outputRequirements: '', openingMessage: '',
  model: null, skills: [], permissions: { mode: 'chat', tools: [] },
  memory: { enabled: false, automaticCandidates: false, maxItems: 8, tokenBudget: 1500 },
  execution: { maxTurns: 10, timeoutMs: 120000 },
});
