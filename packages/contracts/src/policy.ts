import { z } from 'zod';

const uuid = z.uuid(), time = z.number().int().nonnegative();
export const policyScopeSchema = z.strictObject({ appId: uuid, conversationId: uuid });
export const trustedBoundaryNotice = '可信自动化可运行通用文件与 shell 工具。进程代码可能读取当前账户文件和注入的凭据；独立目录、cwd、进程和提示词不是 Windows 安全沙箱。仅对信任的应用和 Skill 启用。';
export const grantSchema = z.strictObject({ id: uuid, ...policyScopeSchema.shape, revisionId: uuid,
  resource: z.enum(['workspace', 'output', 'external']), root: z.string().min(1).max(4096),
  access: z.enum(['read', 'write']), confirmation: z.enum(['never', 'always']), version: z.number().int().positive(),
  revoked: z.boolean(), createdAt: time });
export type PolicyGrant = z.infer<typeof grantSchema>;
export const approvalSchema = z.strictObject({ id: uuid, ...policyScopeSchema.shape, runId: uuid,
  callId: z.string().min(1).max(200), tool: z.string().min(1).max(80), digest: z.string().regex(/^[a-f0-9]{64}$/),
  grantId: uuid.nullable(), grantVersion: z.number().int().positive().nullable(),
  resource: z.string().max(100), createdAt: time, expiresAt: time,
  state: z.enum(['pending', 'allowed', 'denied', 'expired', 'cancelled', 'consumed']) });
export type PolicyApproval = z.infer<typeof approvalSchema>;
export const grantSelectionSchema = z.strictObject({ token: uuid, expiresAt: time, scope: z.literal('policy-directory') }).nullable();
export type GrantSelection = z.infer<typeof grantSelectionSchema>;
export const policyRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('grants.list'), ...policyScopeSchema.shape }),
  z.strictObject({ operation: z.literal('grants.create'), ...policyScopeSchema.shape,
    resource: z.enum(['workspace', 'output', 'external']), token: uuid.optional(), access: z.enum(['read', 'write']),
    confirmation: z.enum(['never', 'always']) }),
  z.strictObject({ operation: z.literal('grants.revoke'), ...policyScopeSchema.shape, grantId: uuid, expectedVersion: z.number().int().positive() }),
  z.strictObject({ operation: z.literal('approvals.list'), ...policyScopeSchema.shape, runId: uuid }),
  z.strictObject({ operation: z.literal('approvals.decide'), ...policyScopeSchema.shape, runId: uuid, approvalId: uuid,
    digest: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['allow', 'deny']) }),
  z.strictObject({ operation: z.literal('trust.revoke'), ...policyScopeSchema.shape }),
]);
export type PolicyRequest = z.infer<typeof policyRequestSchema>;
export const policyReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('grants.list'), grants: z.array(grantSchema) }),
  ...(['grants.create', 'grants.revoke'] as const).map(operation => z.strictObject({ operation: z.literal(operation), grant: grantSchema })),
  z.strictObject({ operation: z.literal('approvals.list'), approvals: z.array(approvalSchema) }),
  z.strictObject({ operation: z.literal('approvals.decide'), approval: approvalSchema }),
  z.strictObject({ operation: z.literal('trust.revoke') }),
]);
export type PolicyReply = z.infer<typeof policyReplySchema>;
// Only the private Main -> Service pipe accepts system dialog results or consent.
export const policyHostRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('select'), ...policyScopeSchema.shape, owner: uuid,
    path: z.string().min(1).max(4096), scope: z.literal('policy-directory') }),
  z.strictObject({ operation: z.literal('trust'), ...policyScopeSchema.shape, notice: z.literal(trustedBoundaryNotice) }),
  z.strictObject({ operation: z.literal('request'), owner: uuid, request: policyRequestSchema }),
]);
export const policyHostReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('select'), selection: grantSelectionSchema }),
  z.strictObject({ operation: z.literal('trust') }),
  z.strictObject({ operation: z.literal('request'), reply: policyReplySchema }),
]);
export type PolicyHostReply = z.infer<typeof policyHostReplySchema>;
export type PolicyHostRequest = z.infer<typeof policyHostRequestSchema>;
