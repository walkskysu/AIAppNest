import { z } from 'zod';
const uuid = z.uuid(), time = z.number().int().nonnegative();
const scope = { appId: uuid, conversationId: uuid };
export const runViewSchema = z.strictObject({ id: uuid, ...scope, requestId: uuid,
  state: z.enum(['queued','starting','running','waiting_approval','cancelling','succeeded','failed','cancelled','interrupted','handled']),
  phase: z.enum(['created','started','accepted','completed']), version: z.number().int().positive(),
  createdAt: time, startedAt: time.nullable(), endedAt: time.nullable(), error: z.string().nullable(),
  usage: z.strictObject({ inputTokens: time, outputTokens: time }).nullable() });
export const runEventSchema = z.strictObject({ runId: uuid, seq: z.number().int().positive(), type: z.string(), payload: z.unknown(), createdAt: time });
export const runRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('submit'), ...scope, revisionId: uuid, requestId: uuid,
    text: z.string().min(1).max(1024 * 1024), attachmentIds: z.array(uuid).max(32), retryOf: uuid.optional() }),
  ...(['get','cancel'] as const).map(operation => z.strictObject({ operation: z.literal(operation), ...scope, runId: uuid })),
  z.strictObject({ operation: z.literal('subscribe'), ...scope, runId: uuid, afterSeq: time }),
  z.strictObject({ operation: z.literal('next'), subscriptionId: uuid, afterSeq: time }),
  z.strictObject({ operation: z.literal('unsubscribe'), subscriptionId: uuid }),
]);
export const runReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('submit'), run: runViewSchema, duplicate: z.boolean() }),
  z.strictObject({ operation: z.literal('get'), run: runViewSchema }),
  z.strictObject({ operation: z.literal('cancel'), run: runViewSchema, accepted: z.literal(true), terminated: z.boolean() }),
  ...(['subscribe','next'] as const).map(operation => z.strictObject({ operation: z.literal(operation), subscriptionId: uuid,
    events: z.array(runEventSchema).max(128), afterSeq: time, terminal: z.boolean() })),
  z.strictObject({ operation: z.literal('unsubscribe') }),
]);
export type RunRequest = z.infer<typeof runRequestSchema>;
export type RunReply = z.infer<typeof runReplySchema>;
