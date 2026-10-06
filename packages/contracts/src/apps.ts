import { z } from 'zod';
import { appConfigSchema } from '@aiappnest/domain';
import { providerConfigSchema } from './providers';
export { appConfigSchema, newAppConfig, type AppConfig } from '@aiappnest/domain';
const uuid = z.uuid(), version = z.number().int().positive(), time = z.number().int().nonnegative();
export const appMetadataSchema = z.strictObject({ name: z.string().trim().min(1).max(80), description: z.string().max(1000),
  icon: z.enum(['spark', 'code', 'book', 'pen']), category: z.string().trim().max(40), favorite: z.boolean() });
export const appIdentitySchema = z.strictObject({ appId: uuid, expectedVersion: version });
export const appIssueSchema = z.enum(['MODEL_REQUIRED', 'PROVIDER_MISSING', 'PROVIDER_CHANGED', 'MODEL_INVALID',
  'CREDENTIAL_UNAVAILABLE', 'SKILL_UNRESOLVED', 'PERMISSION_CONFLICT', 'ROLE_REQUIRED', 'SNAPSHOT_UNAVAILABLE', 'NOT_PUBLISHED']);
export type AppIssue = z.infer<typeof appIssueSchema>;
export const appViewSchema = z.strictObject({ ...appMetadataSchema.shape, id: uuid, version, currentRevisionId: uuid.nullable(),
  createdAt: time, updatedAt: time, lastOpenedAt: time.nullable(), archived: z.boolean(),
  state: z.enum(['usable', 'incomplete', 'missing-dependencies', 'archived']), reasons: z.array(appIssueSchema),
  draft: appConfigSchema, draftIssues: z.array(appIssueSchema), trialStatus: z.literal('not-tested'),
});
export type AppView = z.infer<typeof appViewSchema>;
export const snapshotSchema = z.strictObject({ schemaVersion: z.literal(1), appId: uuid, revisionId: uuid,
  config: appConfigSchema, provider: providerConfigSchema, credentialBinding: uuid,
  runtimeVersion: z.string().max(40), protocol: z.literal('openai-completions'), roleText: z.string().max(40000),
  resources: z.array(z.strictObject({ path: z.enum(['config.json', 'role.md']), hash: z.string().regex(/^[0-9a-f]{64}$/) })).length(2),
  // Only a future trusted trial service may supply an association. No renderer-writable PASS field.
  validation: z.null(),
  skills: z.array(z.strictObject({ id: uuid, version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40),
    path: z.string().regex(/^skills\/[0-9a-f-]{36}\/\d+\.\d+\.\d+\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
    hash: z.string().regex(/^[0-9a-f]{64}$/), sourceHash: z.string().regex(/^[0-9a-f]{64}$/),
  })).max(100).optional(),
});
export type AppSnapshot = z.infer<typeof snapshotSchema>;
export const appRevisionViewSchema = z.strictObject({ id: uuid, appId: uuid, revision: version,
  configHash: z.string().regex(/^[0-9a-f]{64}$/), snapshot: snapshotSchema, createdAt: time });
export type AppRevisionView = z.infer<typeof appRevisionViewSchema>;
export const appRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), query: z.string().max(100), archived: z.boolean(),
    sort: z.enum(['recent', 'name', 'favorite']), limit: z.number().int().min(1).max(100), offset: z.number().int().min(0) }),
  z.strictObject({ operation: z.literal('create'), metadata: appMetadataSchema }),
  z.strictObject({ operation: z.literal('get'), appId: uuid }),
  z.strictObject({ operation: z.literal('update'), ...appIdentitySchema.shape, metadata: appMetadataSchema, draft: appConfigSchema }),
  z.strictObject({ operation: z.literal('publish'), ...appIdentitySchema.shape }),
  z.strictObject({ operation: z.literal('bindSkills'), ...appIdentitySchema.shape, skills: appConfigSchema.shape.skills }),
  z.strictObject({ operation: z.literal('copy'), ...appIdentitySchema.shape }),
  z.strictObject({ operation: z.literal('archive'), ...appIdentitySchema.shape, archived: z.boolean() }),
  z.strictObject({ operation: z.literal('open'), appId: uuid }),
  z.strictObject({ operation: z.literal('revision'), appId: uuid, revisionId: uuid }),
  z.strictObject({ operation: z.literal('activeRuns'), appId: uuid }),
]);
export type AppRequest = z.infer<typeof appRequestSchema>;
export const appReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), apps: z.array(appViewSchema).max(100), total: z.number().int().nonnegative() }),
  ...(['create', 'get', 'update', 'publish', 'copy', 'archive', 'open', 'bindSkills'] as const).map(operation => z.strictObject({ operation: z.literal(operation), app: appViewSchema })),
  z.strictObject({ operation: z.literal('revision'), revision: appRevisionViewSchema }),
  z.strictObject({ operation: z.literal('activeRuns'), count: z.number().int().nonnegative() }),
]);
export type AppReply = z.infer<typeof appReplySchema>;
