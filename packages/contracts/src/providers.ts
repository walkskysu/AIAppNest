import { z } from 'zod';

export const providerFields = {
  name: z.string().trim().min(1).max(80),
  providerType: z.enum(['openai', 'deepseek', 'local-openai']),
  endpoint: z.string().max(256).url(),
  modelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/),
  authMode: z.enum(['api-key', 'none']),
  settings: z.strictObject({ timeoutMs: z.number().int().min(100).max(60000) }),
};
export const providerConfigSchema = z.strictObject(providerFields).superRefine((value, ctx) => {
  // Zod still runs refinements after a URL format failure. Never throw (or echo
  // the submitted URL) while validating an untrusted IPC message.
  if (!URL.canParse(value.endpoint)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid endpoint' });
    return;
  }
  const url = new URL(value.endpoint);
  const clean = !url.username && !url.password && !url.search && !url.hash
    && (value.providerType === 'deepseek' ? /^\/(v1\/?)?$/.test(url.pathname) : /^\/v1\/?$/.test(url.pathname));
  const supported = value.providerType === 'openai'
    ? url.origin === 'https://api.openai.com' && value.authMode === 'api-key'
    : value.providerType === 'deepseek' ? url.origin === 'https://api.deepseek.com' && value.authMode === 'api-key'
      : ['127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol);
  if (!clean || !supported) ctx.addIssue({ code: 'custom', message: 'Unsupported endpoint or authentication' });
});
export const providerSaveSchema = z.strictObject({
  id: z.uuid().optional(), expectedRevision: z.number().int().positive().optional(),
  config: providerConfigSchema,
  credential: z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('keep') }),
    z.strictObject({ action: z.literal('replace'), key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) }),
    z.strictObject({ action: z.literal('clear') }),
  ]),
}).refine(v => Boolean(v.id) === Boolean(v.expectedRevision));
export const providerIdentitySchema = z.strictObject({ id: z.uuid(), revision: z.number().int().positive() });
// Legacy rows may contain unsupported protocols; display them, but runtime validation rejects them.
export const providerViewSchema = z.strictObject({
  ...providerFields, providerType: z.string().max(100), modelId: z.string().max(128),
  id: z.uuid(), revision: z.number().int().positive(), hasCredential: z.boolean(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
});
export const probeCodeSchema = z.enum(['SUCCESS', 'AUTH_FAILED', 'MODEL_NOT_FOUND', 'RATE_LIMITED', 'NETWORK_ERROR', 'PROTOCOL_ERROR', 'TIMEOUT', 'CREDENTIAL_UNAVAILABLE']);
export const providerTestSchema = z.strictObject({
  ...providerIdentitySchema.shape, code: probeCodeSchema,
  testedAt: z.number().int().nonnegative(), durationMs: z.number().int().nonnegative(), stale: z.boolean(),
});
export const providerRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('save'), input: providerSaveSchema }),
  z.strictObject({ operation: z.literal('test'), input: providerIdentitySchema }),
  z.strictObject({ operation: z.literal('delete'), input: providerIdentitySchema }),
]);
export const providerReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), profiles: z.array(providerViewSchema).max(1000) }),
  z.strictObject({ operation: z.literal('save'), profile: providerViewSchema, cleanupPending: z.boolean() }),
  z.strictObject({ operation: z.literal('test'), result: providerTestSchema }),
  z.strictObject({ operation: z.literal('delete'), cleanupPending: z.boolean() }),
]);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderSave = z.infer<typeof providerSaveSchema>;
export type ProviderView = z.infer<typeof providerViewSchema>;
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;
export type ProviderRequest = z.infer<typeof providerRequestSchema>;
export type ProviderReply = z.infer<typeof providerReplySchema>;
export type ProbeCode = z.infer<typeof probeCodeSchema>;
export type ProviderTest = z.infer<typeof providerTestSchema>;
