import { z } from 'zod';
const scope = { appId: z.uuid() };
export const memoryTypeSchema = z.enum(['preference','fact','convention','term']);
const fields = { type: memoryTypeSchema, content: z.string().trim().min(1).max(4000),
  expiresAt: z.number().int().min(0).max(8640000000000000).nullable(), priority: z.number().int().min(0).max(100) };
export const memoryViewSchema = z.strictObject({ ...scope, ...fields, id:z.uuid(), version:z.number().int().positive(),
  status:z.enum(['candidate','active','conflict','disabled','deleted']), confidence:z.number().nullable(),
  sourceConversationId:z.uuid().nullable(), sourceRunId:z.uuid().nullable(), sourceMessageId:z.uuid().nullable(),
  createdAt:z.number(), updatedAt:z.number() });
export const memoryRequestSchema = z.discriminatedUnion('operation',[
  z.strictObject({ operation:z.literal('list'),...scope,type:memoryTypeSchema.optional(),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().nonnegative().default(0) }),
  z.strictObject({ operation:z.literal('save'),...scope,...fields,confirmed:z.literal(true),sourceMessageId:z.uuid().optional() }),
  z.strictObject({ operation:z.literal('update'),...scope,...fields,confirmed:z.literal(true),memoryId:z.uuid(),expectedVersion:z.number().int().positive() }),
  ...(['disable','delete'] as const).map(operation => z.strictObject({ operation:z.literal(operation),...scope,memoryId:z.uuid(),expectedVersion:z.number().int().positive() })),
  z.strictObject({ operation:z.literal('used'),...scope,conversationId:z.uuid(),runId:z.uuid() }),
]);
export const usedMemorySchema = z.strictObject({ memory:memoryViewSchema,position:z.number().int().nonnegative(),injectedTextHash:z.string(),currentlyDeleted:z.boolean() });
export const memoryReplySchema = z.discriminatedUnion('operation',[
  z.strictObject({ operation:z.literal('list'),memories:z.array(memoryViewSchema),total:z.number().int() }),
  ...(['save','update','disable','delete'] as const).map(operation => z.strictObject({ operation:z.literal(operation),memory:memoryViewSchema })),
  z.strictObject({ operation:z.literal('used'),memories:z.array(usedMemorySchema) }),
]);
export type MemoryRequest = z.infer<typeof memoryRequestSchema>;
export type MemoryReply = z.infer<typeof memoryReplySchema>;
export type MemoryView = z.infer<typeof memoryViewSchema>;
