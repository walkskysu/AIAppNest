import { z } from 'zod';
const scope = { appId: z.uuid() };
export const memoryTypeSchema = z.enum(['preference','fact','convention','term']);
const fields = { type: memoryTypeSchema, content: z.string().trim().min(1).max(4000),
  expiresAt: z.number().int().min(0).max(8640000000000000).nullable(), priority: z.number().int().min(0).max(100) };
export const memoryViewSchema = z.strictObject({ ...scope, ...fields, id:z.uuid(), version:z.number().int().positive(),
  status:z.enum(['candidate','active','conflict','disabled','deleted']), confidence:z.number().nullable(),
  sourceConversationId:z.uuid().nullable(), sourceRunId:z.uuid().nullable(), sourceMessageId:z.uuid().nullable(),
  createdAt:z.number(), updatedAt:z.number() });
const page = { limit:z.number().int().min(1).max(100).default(20),offset:z.number().int().nonnegative().default(0) };
const target = z.strictObject({ id:z.uuid(),version:z.number().int().positive() });
export const extractionTaskSchema=z.strictObject({id:z.uuid(),...scope,sourceConversationId:z.uuid(),sourceRunId:z.uuid(),sourceMessageId:z.uuid(),
  sourceVersion:z.string(),policyVersion:z.string(),dedupeKey:z.string(),state:z.enum(['pending','running','succeeded','failed','cancelled']),error:z.string().nullable(),
  attempts:z.number().int(),version:z.number().int(),createdAt:z.number(),updatedAt:z.number()});
export const candidateViewSchema=z.strictObject({memory:memoryViewSchema,conflicts:z.array(memoryViewSchema),sourceAvailable:z.boolean(),
  sourceContent:z.string().nullable(),taskId:z.uuid()});
const hit=z.strictObject({id:z.uuid(),kind:z.enum(['memory','message']),conversationId:z.uuid().nullable(),content:z.string(),snippet:z.string(),version:z.number().int(),updatedAt:z.number()});
export const memoryRequestSchema = z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('candidates'),...scope,...page}),
  z.strictObject({operation:z.literal('tasks'),...scope,...page}),
  z.strictObject({operation:z.literal('retry'),...scope,taskId:z.uuid(),expectedVersion:z.number().int().positive()}),
  z.strictObject({operation:z.literal('review'),...scope,memoryId:z.uuid(),expectedVersion:z.number().int().positive(),confirmed:z.literal(true),
    action:z.enum(['accept','reject','keep','replace','merge']),content:z.string().trim().min(1).max(4000).optional(),targets:z.array(target).max(100).default([])}),
  z.strictObject({operation:z.literal('search'),...scope,query:z.string().max(200),kind:z.enum(['memory','message']),mode:z.enum(['phrase','terms','fuzzy']).default('phrase'),...page}),
  z.strictObject({operation:z.literal('rebuild'),...scope}),
  z.strictObject({operation:z.literal('history'),...scope,memoryId:z.uuid()}),
  z.strictObject({ operation:z.literal('list'),...scope,type:memoryTypeSchema.optional(),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().nonnegative().default(0) }),
  z.strictObject({ operation:z.literal('save'),...scope,...fields,confirmed:z.literal(true),sourceMessageId:z.uuid().optional() }),
  z.strictObject({ operation:z.literal('update'),...scope,...fields,confirmed:z.literal(true),memoryId:z.uuid(),expectedVersion:z.number().int().positive() }),
  ...(['disable','delete'] as const).map(operation => z.strictObject({ operation:z.literal(operation),...scope,memoryId:z.uuid(),expectedVersion:z.number().int().positive() })),
  z.strictObject({ operation:z.literal('used'),...scope,conversationId:z.uuid(),runId:z.uuid() }),
]);
export const usedMemorySchema = z.strictObject({ memory:memoryViewSchema,position:z.number().int().nonnegative(),injectedTextHash:z.string(),currentlyDeleted:z.boolean() });
export const memoryReplySchema = z.discriminatedUnion('operation',[
  z.strictObject({operation:z.literal('candidates'),candidates:z.array(candidateViewSchema),total:z.number().int()}),
  z.strictObject({operation:z.literal('tasks'),tasks:z.array(extractionTaskSchema),total:z.number().int()}),
  z.strictObject({operation:z.literal('retry'),task:extractionTaskSchema}),
  z.strictObject({operation:z.literal('review'),memory:memoryViewSchema}),
  z.strictObject({operation:z.literal('search'),hits:z.array(hit),total:z.number().int()}),
  z.strictObject({operation:z.literal('rebuild')}),
  z.strictObject({operation:z.literal('history'),relations:z.array(z.strictObject({supersedesId:z.uuid(),supersedesVersion:z.number().int(),version:z.number().int()}))}),
  z.strictObject({ operation:z.literal('list'),memories:z.array(memoryViewSchema),total:z.number().int() }),
  ...(['save','update','disable','delete'] as const).map(operation => z.strictObject({ operation:z.literal(operation),memory:memoryViewSchema })),
  z.strictObject({ operation:z.literal('used'),memories:z.array(usedMemorySchema) }),
]);
export type MemoryRequest = z.infer<typeof memoryRequestSchema>;
export type MemoryReply = z.infer<typeof memoryReplySchema>;
export type MemoryView = z.infer<typeof memoryViewSchema>;
export type CandidateView = z.infer<typeof candidateViewSchema>;
