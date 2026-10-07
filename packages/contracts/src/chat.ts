import { z } from 'zod';
import { runViewSchema } from './runs';
import { appViewSchema } from './apps';
const uuid = z.uuid(), time = z.number().int().nonnegative();
const scope = { appId: uuid, conversationId: uuid };
export const conversationViewSchema = z.strictObject({ id: uuid, appId: uuid, revisionId: uuid,
  title: z.string().max(200), status: z.enum(['active','archived']), createdAt: time, updatedAt: time });
export const messageViewSchema = z.strictObject({ id: uuid, ...scope, runId: uuid.nullable(),
  role: z.enum(['user','assistant','tool','system']), content: z.string(), status: z.enum(['streaming','complete','failed']), createdAt: time });
export const trialViewSchema = z.strictObject({ id: uuid, ...scope, revisionId: uuid, configHash: z.string(),
  run: runViewSchema.nullable(), stale: z.boolean(), published: z.boolean() });
const page = { limit: z.number().int().min(1).max(100), offset: time };
export const chatRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), appId: uuid, query: z.string().max(100), ...page }),
  z.strictObject({ operation: z.literal('create'), appId: uuid, conversationId: uuid, title: z.string().trim().min(1).max(200) }),
  z.strictObject({ operation: z.literal('history'), ...scope, ...page }),
  z.strictObject({ operation: z.literal('rename'), ...scope, title: z.string().trim().min(1).max(200) }),
  z.strictObject({ operation: z.literal('delete'), ...scope, scope: z.literal('chat-and-attachments'), preserveMemory: z.literal(true), preserveArtifacts: z.literal(true) }),
  z.strictObject({ operation: z.literal('trial.start'), appId: uuid, expectedVersion: z.number().int().positive(), trialId: uuid, text: z.string().trim().min(1).max(65536) }),
  z.strictObject({ operation: z.literal('trial.list'), appId: uuid }),
  z.strictObject({ operation: z.literal('trial.publish'), appId: uuid, trialId: uuid, expectedVersion: z.number().int().positive() }),
]);
export const chatReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), conversations: z.array(conversationViewSchema), total: time }),
  ...(['create','rename'] as const).map(operation => z.strictObject({ operation: z.literal(operation), conversation: conversationViewSchema })),
  z.strictObject({ operation: z.literal('history'), conversation: conversationViewSchema, messages: z.array(messageViewSchema), total: time, runs: z.array(runViewSchema) }),
  z.strictObject({ operation: z.literal('delete'), terminated: z.boolean(), archived: z.boolean() }),
  z.strictObject({ operation: z.literal('trial.start'), trial: trialViewSchema }),
  z.strictObject({ operation: z.literal('trial.list'), trials: z.array(trialViewSchema) }),
  z.strictObject({ operation: z.literal('trial.publish'), app: appViewSchema }),
]);
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatReply = z.infer<typeof chatReplySchema>;
export type ConversationView = z.infer<typeof conversationViewSchema>;
export type MessageView = z.infer<typeof messageViewSchema>;
export type TrialView = z.infer<typeof trialViewSchema>;
