import { z } from 'zod';
const uuid = z.uuid();
export const fileScopeSchema = z.strictObject({ appId: uuid, conversationId: uuid });
const scope = fileScopeSchema.shape;
export const fileSelectionSchema = z.strictObject({ token: uuid, displayName: z.string(), expiresAt: z.number() }).nullable();
export const fileViewSchema = z.strictObject({ id: uuid, ...scope, runId: uuid.nullable(), kind: z.enum(['attachment','artifact']),
  displayName: z.string(), mimeType: z.string(), size: z.number(), hash: z.string().nullable(), createdAt: z.number(),
  status: z.enum(['ready','missing','changed','forbidden','type-mismatch']), externalOpen: z.boolean() });
export const fileRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('attachments.import'), ...scope, token: uuid }),
  z.strictObject({ operation: z.literal('attachments.cancel'), ...scope, token: uuid }),
  z.strictObject({ operation: z.literal('artifacts.list'), ...scope, runId: uuid.optional(), offset: z.number().int().nonnegative().default(0) }),
  z.strictObject({ operation: z.literal('artifacts.preview'), ...scope, artifactId: uuid }),
  z.strictObject({ operation: z.literal('artifacts.open'), ...scope, artifactId: uuid, mode: z.enum(['folder','external']) }),
]);
export const fileReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('attachments.import'), file: fileViewSchema }),
  z.strictObject({ operation: z.literal('attachments.cancel') }),
  z.strictObject({ operation: z.literal('artifacts.list'), files: z.array(fileViewSchema), hasMore: z.boolean() }),
  z.strictObject({ operation: z.literal('artifacts.preview'), file: fileViewSchema, preview: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('text'), text: z.string().max(256 * 1024) }),
    z.strictObject({ kind: z.literal('image'), data: z.string().max(3 * 1024 * 1024), mimeType: z.enum(['image/png','image/jpeg']) }),
    z.strictObject({ kind: z.literal('unavailable'), reason: z.string() }),
  ]) }),
  z.strictObject({ operation: z.literal('artifacts.open'), opened: z.boolean() }),
]);
export const fileHostRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('select'), ...scope, owner: uuid, path: z.string().min(1).max(4096) }),
  z.strictObject({ operation: z.literal('request'), owner: uuid, request: fileRequestSchema }),
]);
export const fileHostReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('select'), selection: fileSelectionSchema }),
  // Path is private to Main; it must never be forwarded to Renderer.
  z.strictObject({ operation: z.literal('request'), reply: fileReplySchema, openPath: z.string().optional() }),
]);
export type FileRequest = z.infer<typeof fileRequestSchema>;
export type FileReply = z.infer<typeof fileReplySchema>;
export type FileView = z.infer<typeof fileViewSchema>;
export type FileSelection = z.infer<typeof fileSelectionSchema>;
export type FileHostRequest = z.infer<typeof fileHostRequestSchema>;
export type FileHostReply = z.infer<typeof fileHostReplySchema>;
