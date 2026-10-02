import { z } from 'zod';
import { SERVICE_PROTOCOL_VERSION } from '@aiappnest/domain';

export const errorCodeSchema = z.enum([
  'INVALID_INPUT', 'FORBIDDEN', 'NOT_READY', 'START_FAILED', 'START_TIMEOUT',
  'PROTOCOL_ERROR', 'SERVICE_EXITED', 'REQUEST_TIMEOUT', 'SHUTTING_DOWN', 'BUSY', 'STORAGE_UNAVAILABLE',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const errorSchema = z.strictObject({ code: errorCodeSchema, message: z.string().max(200) });
export type PublicError = z.infer<typeof errorSchema>;
const messages: Record<ErrorCode, string> = {
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
export const channels = Object.freeze({ status: 'foundation:status', retry: 'foundation:retry', ping: 'foundation:ping', changed: 'foundation:changed' });
const id = z.uuid();
export const hostInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hello'), version: z.literal(SERVICE_PROTOCOL_VERSION), nonce: id }),
  z.strictObject({ kind: z.literal('ping'), id, input: pingInputSchema }),
  z.strictObject({ kind: z.literal('shutdown') }),
]);
export const hostOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), version: z.literal(SERVICE_PROTOCOL_VERSION), nonce: id, pid: z.number().int().positive(), nodeVersion: z.string().max(30) }),
  z.strictObject({ kind: z.literal('response'), id, result: resultSchema(pingOutputSchema) }),
  z.strictObject({ kind: z.literal('fatal'), error: errorSchema }),
]);
export type HostInput = z.infer<typeof hostInputSchema>;
export type HostOutput = z.infer<typeof hostOutputSchema>;
export interface DesktopAPI {
  getStatus(): Promise<Result<ServiceStatus>>;
  retryService(): Promise<Result<ServiceStatus>>;
  ping(input: PingInput): Promise<Result<PingOutput>>;
  onStatusChanged(callback: (status: ServiceStatus) => void): () => void;
}
