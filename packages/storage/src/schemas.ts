import { z } from 'zod';
import { appConfigSchema } from '@aiappnest/domain';
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const time = z.number().int().min(0).max(8640000000000000);
const version = z.number().int().positive();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string();
const appId = uuid, id = uuid;
export const schemas = {
  apps: z.strictObject({ id, name: text, description: text, icon: text.nullable(), status: z.enum(['draft','ready','archived']), currentRevisionId: uuid.nullable(), version, createdAt: time, updatedAt: time }),
  revisions: z.strictObject({ id, appId, revision: version, providerProfileId: uuid,
    config: z.union([appConfigSchema, z.strictObject({ schemaVersion: z.literal(1), modelId: text,
      memory: z.strictObject({ enabled: z.boolean(), maxItems: z.number().int().nonnegative(), tokenBudget: z.number().int().nonnegative() }),
      permissions: z.strictObject({ mode: z.enum(['chat','controlled-files','trusted-automation']), shell: z.boolean() }),
    })]), roleText: text, runtimeVersion: text, createdAt: time }),
  skills: z.strictObject({ id, version: text.regex(/^\d+\.\d+\.\d+$/).max(40), hash, sourcePath: text, metadata: z.strictObject({ name: text, description: text }), importedAt: time }),
  appSkills: z.strictObject({ revisionId: uuid, skillId: uuid, skillVersion: text, enabled: z.boolean() }),
  conversations: z.strictObject({ id, appId, revisionId: uuid, title: text, piSessionFile: text.nullable(), status: z.enum(['active','archived']), createdAt: time, updatedAt: time }),
  runs: z.strictObject({ id, appId, conversationId: uuid, requestId: uuid,
    state: z.enum(['queued','starting','running','waiting_approval','cancelling','succeeded','failed','cancelled','interrupted','handled']),
    phase: z.enum(['created','started','accepted','completed']), version, createdAt: time, startedAt: time.nullable(), endedAt: time.nullable(), error: text.nullable(),
    usage: z.strictObject({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).nullable(),
  }),
  messages: z.strictObject({ id, appId, conversationId: uuid, runId: uuid.nullable(), role: z.enum(['user','assistant','tool','system']), content: text, status: z.enum(['streaming','complete','failed']), createdAt: time }),
  events: z.strictObject({ runId: uuid, seq: version, type: text, payload: z.json(), createdAt: time }),
  memories: z.strictObject({ id, appId, version, priority: z.number().int().min(0).max(100).default(0), type: z.enum(['preference','fact','convention','term']), content: text, status: z.enum(['candidate','active','conflict','disabled','deleted']), confidence: z.number().min(0).max(1).nullable(), sourceConversationId: uuid.nullable(), sourceRunId: uuid.nullable(), sourceMessageId: uuid.nullable(), createdAt: time, updatedAt: time, expiresAt: time.nullable() }),
  memoryLinks: z.strictObject({ runId: uuid, appId, memoryId: uuid, memoryVersion: version, injectedTextHash: hash, position: z.number().int().nonnegative().default(0) }),
  attachments: z.strictObject({ id, appId, conversationId: uuid, relativePath: text, displayName: text.max(255), mimeType: text, size: z.number().int().nonnegative(), hash, createdAt: time }),
  artifacts: z.strictObject({ displayName: text.max(255).default(''), sourceKey: text.default(''), id, appId, conversationId: uuid, runId: uuid, relativePath: text, mimeType: text, size: z.number().int().nonnegative(), hash, createdAt: time }),
  providers: z.strictObject({ id, name: text.min(1).max(80), providerType: text.max(100), modelId: text.max(128), authMode: z.enum(['api-key','none']), revision: version,
    endpoint: z.url().refine(value => { if (!URL.canParse(value)) return false; const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }),
    secretRef: z.string().regex(/^secret:[0-9a-f-]{36}$/).nullable(), settings: z.strictObject({ timeoutMs: z.number().int().positive() }), createdAt: time, updatedAt: time }),
  grants: z.strictObject({ id, appId, capability: text, resource: text, mode: z.enum(['read','write','execute']), createdAt: time }),
};
