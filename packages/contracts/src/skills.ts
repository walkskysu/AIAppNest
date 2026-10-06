import { z } from 'zod';

export const skillKeySchema = z.strictObject({ id: z.uuid(), version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40) });
export const skillDiagnosticSchema = z.strictObject({ path: z.string().max(512), line: z.number().int().nonnegative(),
  code: z.string().max(80), message: z.string().max(300), status: z.enum(['error', 'unverified']) });
export const skillReportSchema = z.strictObject({ valid: z.boolean(), sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  files: z.array(z.strictObject({ path: z.string().max(512), bytes: z.number().int().nonnegative() })).max(1000),
  scripts: z.array(z.string().max(512)).max(1000), diagnostics: z.array(skillDiagnosticSchema).max(2000),
  dependencies: z.array(z.strictObject({ name: z.string().max(100), constraint: z.string().max(100),
    status: z.enum(['satisfied', 'missing', 'unverified']), detail: z.string().max(300) })).max(100),
  capabilities: z.array(z.string().max(100)).max(100), allowedTools: z.array(z.string().max(100)).max(100),
});
export const skillViewSchema = z.strictObject({ ...skillKeySchema.shape, sha256: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().max(64), description: z.string().max(1024), source: z.string().max(4096),
  importedAt: z.number().int().nonnegative(), entryFile: z.literal('SKILL.md'),
  versionOrigin: z.enum(['upstream', 'platform']), identityOrigin: z.enum(['declared', 'source']), report: skillReportSchema });
export type SkillView = z.infer<typeof skillViewSchema>;
export type SkillReport = z.infer<typeof skillReportSchema>;
export type SkillDiagnostic = z.infer<typeof skillDiagnosticSchema>;
export const skillSelectionSchema = z.strictObject({ token: z.uuid(), expiresAt: z.number().int().positive(), scope: z.literal('skill-import') }).nullable();
export const skillRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), limit: z.number().int().min(1).max(100), offset: z.number().int().nonnegative() }),
  z.strictObject({ operation: z.literal('import'), token: z.uuid() }),
  ...(['get', 'validate', 'delete'] as const).map(operation => z.strictObject({ operation: z.literal(operation), ...skillKeySchema.shape })),
]);
export const skillReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list'), skills: z.array(skillViewSchema).max(100), total: z.number().int().nonnegative() }),
  z.strictObject({ operation: z.literal('get'), skill: skillViewSchema }),
  z.strictObject({ operation: z.literal('import'), skill: skillViewSchema.nullable(), report: skillReportSchema, duplicate: z.boolean() }),
  z.strictObject({ operation: z.literal('validate'), report: skillReportSchema }),
  z.strictObject({ operation: z.literal('delete') }),
]);
export type SkillRequest = z.infer<typeof skillRequestSchema>;
export type SkillReply = z.infer<typeof skillReplySchema>;
export type SkillSelection = z.infer<typeof skillSelectionSchema>;
// Private Main -> Service pipe only. Never included in the renderer request schema.
export const skillHostRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('select'), path: z.string().min(1).max(4096), owner: z.uuid(), scope: z.literal('skill-import') }),
  z.strictObject({ operation: z.literal('request'), owner: z.uuid(), request: skillRequestSchema }),
]);
export const skillHostReplySchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('select'), selection: skillSelectionSchema }),
  z.strictObject({ operation: z.literal('request'), reply: skillReplySchema }),
]);
export type SkillHostRequest = z.infer<typeof skillHostRequestSchema>;
export type SkillHostReply = z.infer<typeof skillHostReplySchema>;
