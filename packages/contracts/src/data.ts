import { z } from 'zod';

export const dataScope = z.strictObject({ appId:z.uuid(), conversationId:z.uuid().optional() });
export const dataRequestSchema = z.discriminatedUnion('operation',[
  z.strictObject({ operation:z.literal('backups.create'), token:z.uuid() }),
  z.strictObject({ operation:z.literal('backups.status'), jobId:z.uuid() }),
  z.strictObject({ operation:z.literal('backups.cancel'), jobId:z.uuid() }),
  z.strictObject({ operation:z.literal('backups.preflight'), token:z.uuid() }),
  z.strictObject({ operation:z.literal('backups.restore'), token:z.uuid(), targetToken:z.uuid() }),
  z.strictObject({ operation:z.literal('backups.activate'), jobId:z.uuid() }),
  z.strictObject({ operation:z.literal('recycle.list') }),
  z.strictObject({ operation:z.literal('recycle.preview'), ...dataScope.shape }),
  z.strictObject({ operation:z.literal('recycle.move'), ...dataScope.shape }),
  z.strictObject({ operation:z.literal('recycle.restore'), ...dataScope.shape }),
  z.strictObject({ operation:z.literal('recycle.purge'), ...dataScope.shape, deleteMemories:z.boolean(),deleteArtifacts:z.boolean(),confirm:z.literal(true) }),
  z.strictObject({ operation:z.literal('recycle.retry'), jobId:z.uuid() }),
]);
export const dataHostRequestSchema=z.discriminatedUnion('operation',[
  z.strictObject({ operation:z.literal('select'),owner:z.uuid(),purpose:z.enum(['backup','package','restore']),path:z.string().min(1).max(4096) }),
  z.strictObject({ operation:z.literal('request'),owner:z.uuid(),request:dataRequestSchema }),
]);
export const dataJobSchema=z.strictObject({ id:z.uuid(),kind:z.enum(['backup','restore','delete']),state:z.enum(['waiting','copying','verifying','ready','succeeded','cancelled','failed','interrupted']),files:z.number().int().nonnegative(),error:z.string().max(80).nullable(),createdAt:z.number(), output:z.string().max(4096).optional() });
export const recycleItemSchema=z.strictObject({ appId:z.string(),conversationId:z.string().optional(),name:z.string(),createdAt:z.number() });
export const dataReplySchema=z.strictObject({ operation:z.string(),job:dataJobSchema.optional(),jobs:z.array(dataJobSchema).optional(),token:z.uuid().optional(),items:z.array(recycleItemSchema).optional(),preview:z.strictObject({ conversations:z.number(),attachments:z.number(),artifacts:z.number(),memories:z.number(),sharedSkills:z.number() }).optional(),verified:z.boolean().optional(),restartRequired:z.boolean().optional() });
export type DataRequest=z.infer<typeof dataRequestSchema>;
export type DataHostRequest=z.infer<typeof dataHostRequestSchema>;
export type DataReply=z.infer<typeof dataReplySchema>;
export type DataJob=z.infer<typeof dataJobSchema>;
