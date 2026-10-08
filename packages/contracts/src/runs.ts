import { z } from 'zod';
const uuid = z.uuid(), time = z.number().int().nonnegative();
const scope = { appId: uuid, conversationId: uuid };
export const diagnosticSchema = z.strictObject({ runId:uuid,state:z.string(),phase:z.string(),errorCategory:z.string().nullable(),
  durations:z.strictObject({ queuedMs:time,activeMs:time.nullable(),startupMs:time,runningMs:time,approvalMs:time }),exitCode:z.number().int().nullable(),
  usage:z.strictObject({ inputTokens:time,outputTokens:time }).nullable(),cost:z.literal('unknown'),
  permissions:z.strictObject({ waiting:time,resolved:time }),recoveryAction:z.enum(['none','manual_retry','confirmed_completion']),
  output:z.enum(['projection','display_truncated','unavailable']),outputSource:z.enum(['pi_session_verified','unavailable']),
  fullOutputFile:z.null(),storage:z.enum(['saved','unsaved']),logSaved:z.boolean() });
export const runViewSchema = z.strictObject({ id: uuid, ...scope, requestId: uuid,
  state: z.enum(['queued','starting','running','waiting_approval','cancelling','succeeded','failed','cancelled','interrupted','handled']),
  phase: z.enum(['created','started','accepted','completed']), version: z.number().int().positive(),
  createdAt: time, startedAt: time.nullable(), endedAt: time.nullable(), error: z.string().nullable(),
  usage: z.strictObject({ inputTokens: time, outputTokens: time }).nullable() });
export const runEventSchema = z.strictObject({ runId: uuid, seq: z.number().int().positive(), type: z.string(), payload: z.unknown(), createdAt: time });
export const runRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('submit'), ...scope, revisionId: uuid, requestId: uuid,
    text: z.string().min(1).max(1024 * 1024), attachmentIds: z.array(uuid).max(32), retryOf: uuid.optional() }),
  ...(['get','cancel','repair','diagnostics','diagnostics.export'] as const).map(operation => z.strictObject({ operation: z.literal(operation), ...scope, runId: uuid })),
  z.strictObject({ operation: z.literal('subscribe'), ...scope, runId: uuid, afterSeq: time }),
  z.strictObject({ operation: z.literal('next'), subscriptionId: uuid, afterSeq: time }),
  z.strictObject({ operation: z.literal('unsubscribe'), subscriptionId: uuid }),
]);
export const runReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('submit'), run: runViewSchema, duplicate: z.boolean() }),
  z.strictObject({ operation: z.literal('get'), run: runViewSchema, storage:z.enum(['saved','unsaved']).optional() }),
  z.strictObject({ operation:z.literal('repair'),status:z.enum(['repaired','unchanged','no_boundary','no_session','session_invalid','busy']),inserted:time,confirmed:z.boolean(),truncated:z.boolean().optional(),source:z.enum(['pi_session_verified','unavailable']).optional() }),
  z.strictObject({ operation:z.literal('diagnostics'),diagnostic:diagnosticSchema }),
  z.strictObject({ operation:z.literal('diagnostics.export'),diagnostic:diagnosticSchema,saved:z.boolean().optional() }),
  z.strictObject({ operation: z.literal('cancel'), run: runViewSchema, accepted: z.literal(true), terminated: z.boolean() }),
  ...(['subscribe','next'] as const).map(operation => z.strictObject({ operation: z.literal(operation), subscriptionId: uuid,
    events: z.array(runEventSchema).max(128), afterSeq: time, terminal: z.boolean(),resetRequired:z.boolean().optional(),
    snapshotSeq:time.optional(),storage:z.enum(['saved','unsaved']).optional() })),
  z.strictObject({ operation: z.literal('unsubscribe') }),
]);
export type RunRequest = z.infer<typeof runRequestSchema>;
export type RunReply = z.infer<typeof runReplySchema>;
