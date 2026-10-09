import { dataHostRequestSchema, dataReplySchema, type DataRequest, type DataReply } from './data';
export * from './data';
import { memoryRequestSchema, memoryReplySchema, type MemoryRequest, type MemoryReply } from './memories';
export * from './memories';
import { chatRequestSchema, chatReplySchema, type ChatRequest, type ChatReply } from './chat';
export * from './chat';
import { runRequestSchema, runReplySchema, type RunRequest, type RunReply } from './runs';
export * from './runs';
import { z } from 'zod';
import { fileHostRequestSchema, fileHostReplySchema, type FileRequest, type FileReply, type FileSelection } from './files';
export * from './files';
import { SERVICE_PROTOCOL_VERSION } from '@aiappnest/domain';
import { providerRequestSchema, providerReplySchema, type ProviderRequest, type ProviderReply } from './providers';
export * from './providers';
import { appRequestSchema, appReplySchema, type AppRequest, type AppReply } from './apps';
export * from './apps';
import { skillHostRequestSchema, skillHostReplySchema, type SkillRequest, type SkillReply, type SkillSelection } from './skills';
export * from './skills';
import { policyHostRequestSchema, policyHostReplySchema, type PolicyRequest, type PolicyReply, type GrantSelection } from './policy';
export * from './policy';

export const errorCodeSchema = z.enum([
  'FILE_QUOTA', 'FILE_CHANGED', 'FILE_TYPE', 'FILE_CANCELLED', 'FILE_IO',
  'INVALID_INPUT', 'FORBIDDEN', 'NOT_READY', 'START_FAILED', 'START_TIMEOUT',
  'PROTOCOL_ERROR', 'SERVICE_EXITED', 'REQUEST_TIMEOUT', 'SHUTTING_DOWN', 'BUSY', 'STORAGE_UNAVAILABLE',
  'VERSION_CONFLICT', 'NOT_FOUND', 'CREDENTIAL_UNAVAILABLE', 'PROVIDER_IN_USE', 'APP_UNAVAILABLE',
  'SKILL_INTEGRITY', 'SKILL_IN_USE',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const errorSchema = z.strictObject({ code: errorCodeSchema, message: z.string().max(200) });
export type PublicError = z.infer<typeof errorSchema>;
const messages: Record<ErrorCode, string> = {
  FILE_QUOTA: '文件大小或托管存储配额超限。', FILE_CHANGED: '文件已变化，请重新导入或生成。',
  FILE_TYPE: '文件类型或内容不受支持。', FILE_CANCELLED: '文件导入已取消。', FILE_IO: '文件操作失败，未登记半成品。请检查磁盘空间和文件状态后重试。',
  SKILL_INTEGRITY: 'Skill 内容完整性校验失败，已阻止使用。请检查源包或版本快照。',
  SKILL_IN_USE: 'Skill 被已发布应用版本引用，不能删除。',
  APP_UNAVAILABLE: '应用已归档、尚未发布或存在活动任务，无法执行此操作。',
  VERSION_CONFLICT: '配置已发生变化，请重新加载后再操作。', NOT_FOUND: '请求的记录不存在或不属于此应用。',
  CREDENTIAL_UNAVAILABLE: '凭据无法保存或读取，请检查 Windows 用户环境并重新输入。',
  PROVIDER_IN_USE: '此模型配置被应用版本引用，无法删除。',
  INVALID_INPUT: '请求格式无效。', FORBIDDEN: '请求来源不被允许。', NOT_READY: '服务尚未就绪。',
  START_FAILED: '服务启动失败，请检查运行时后重试。', START_TIMEOUT: '服务启动握手超时。',
  PROTOCOL_ERROR: '服务通信协议不匹配。', SERVICE_EXITED: '服务意外退出，请手动重试。',
  REQUEST_TIMEOUT: '请求超时，服务已停止；请求不会自动重放。',
  SHUTTING_DOWN: '应用正在关闭。', BUSY: '请求过多，请稍后重试。',
  STORAGE_UNAVAILABLE: '本地数据初始化失败，原有数据已保留。请检查数据目录后重试。',
};
export const publicError = (code: ErrorCode): PublicError => ({ code, message: messages[code] });
export const emptySchema = z.strictObject({});
export const pingInputSchema = z.strictObject({ text: z.string().max(256) });
export const pingOutputSchema = z.strictObject({
  text: z.string().max(256), pid: z.number().int().positive(), nodeVersion: z.string().max(30),
});
export const statusSchema = z.strictObject({
  phase: z.enum(['stopped', 'starting', 'ready', 'stopping', 'failed']),
  revision: z.number().int().nonnegative(),
  pid: z.number().int().positive().nullable(), error: errorSchema.nullable(),
});
export type ServiceStatus = z.infer<typeof statusSchema>;
export type PingInput = z.infer<typeof pingInputSchema>;
export type PingOutput = z.infer<typeof pingOutputSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export const resultSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value }),
  z.strictObject({ ok: z.literal(false), error: errorSchema }),
]);
export const channels = Object.freeze({ data:'data:request', selectData:'data:select', memories: 'memories:request', files: 'files:request', selectAttachment: 'files:select', chat: 'chat:request', external: 'chat:external', runs: 'runs:request', status: 'foundation:status', retry: 'foundation:retry', ping: 'foundation:ping', changed: 'foundation:changed', providers: 'providers:request', apps: 'apps:request', skills: 'skills:request', selectSkill: 'skills:select', policy: 'policy:request', selectGrant: 'policy:select', trust: 'policy:trust' });
const id = z.uuid();
export const hostInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind:z.literal('data'),id,input:dataHostRequestSchema}),
  z.strictObject({ kind:z.literal('memories'),id,input:memoryRequestSchema }),
  z.strictObject({ kind: z.literal('files'), id, input: fileHostRequestSchema }),
  z.strictObject({ kind: z.literal('hello'), version: z.literal(SERVICE_PROTOCOL_VERSION), nonce: id }),
  z.strictObject({ kind: z.literal('ping'), id, input: pingInputSchema }),
  z.strictObject({ kind: z.literal('providers'), id, input: providerRequestSchema }),
  z.strictObject({ kind: z.literal('apps'), id, input: appRequestSchema }),
  z.strictObject({ kind: z.literal('skills'), id, input: skillHostRequestSchema }),
  z.strictObject({ kind: z.literal('policy'), id, input: policyHostRequestSchema }),
  z.strictObject({ kind: z.literal('chat'), id, input: chatRequestSchema }),
  z.strictObject({ kind: z.literal('runs'), id, input: runRequestSchema }),
  z.strictObject({ kind: z.literal('shutdown') }),
]);
export const hostOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind:z.literal('data-response'),id,result:resultSchema(dataReplySchema)}),
  z.strictObject({ kind:z.literal('memories-response'),id,result:resultSchema(memoryReplySchema) }),
  z.strictObject({ kind: z.literal('files-response'), id, result: resultSchema(fileHostReplySchema) }),
  z.strictObject({ kind: z.literal('ready'), version: z.literal(SERVICE_PROTOCOL_VERSION), nonce: id, pid: z.number().int().positive(), nodeVersion: z.string().max(30) }),
  z.strictObject({ kind: z.literal('response'), id, result: resultSchema(pingOutputSchema) }),
  z.strictObject({ kind: z.literal('providers-response'), id, result: resultSchema(providerReplySchema) }),
  z.strictObject({ kind: z.literal('apps-response'), id, result: resultSchema(appReplySchema) }),
  z.strictObject({ kind: z.literal('skills-response'), id, result: resultSchema(skillHostReplySchema) }),
  z.strictObject({ kind: z.literal('policy-response'), id, result: resultSchema(policyHostReplySchema) }),
  z.strictObject({ kind: z.literal('chat-response'), id, result: resultSchema(chatReplySchema) }),
  z.strictObject({ kind: z.literal('runs-response'), id, result: resultSchema(runReplySchema) }),
  z.strictObject({ kind: z.literal('fatal'), error: errorSchema }),
]);
export type HostInput = z.infer<typeof hostInputSchema>;
export type HostOutput = z.infer<typeof hostOutputSchema>;
export interface DesktopAPI {
  data(input:DataRequest):Promise<Result<DataReply>>;
  selectData(purpose:'backup'|'package'|'restore'):Promise<Result<DataReply>>;
  memories(input: MemoryRequest): Promise<Result<MemoryReply>>;
  files(input: FileRequest): Promise<Result<FileReply>>;
  selectAttachment(scope: { appId: string; conversationId: string }): Promise<Result<FileSelection>>;
  chat(input: ChatRequest): Promise<Result<ChatReply>>;
  openExternal(url: string): Promise<Result<boolean>>;
  runs(input: RunRequest): Promise<Result<RunReply>>;
  selectGrantDirectory(scope: { appId: string; conversationId: string }): Promise<Result<GrantSelection>>;
  selectTrustedAutomation(scope: { appId: string; conversationId: string }): Promise<Result<boolean>>;
  policy(input: PolicyRequest): Promise<Result<PolicyReply>>;
  selectSkillDirectory(): Promise<Result<SkillSelection>>;
  skills(input: SkillRequest): Promise<Result<SkillReply>>;
  apps(input: AppRequest): Promise<Result<AppReply>>;
  providers(input: ProviderRequest): Promise<Result<ProviderReply>>;
  getStatus(): Promise<Result<ServiceStatus>>;
  retryService(): Promise<Result<ServiceStatus>>;
  ping(input: PingInput): Promise<Result<PingOutput>>;
  onStatusChanged(callback: (status: ServiceStatus) => void): () => void;
}
