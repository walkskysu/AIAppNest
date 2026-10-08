import { closeSync, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const sessionLimit = 32 * 1024 * 1024;
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export interface SessionEntry { type: string; id: string; parentId: string | null; message?: any; customType?: string; data?: any }
export interface SessionSnapshot { sessionId: string | null; entries: SessionEntry[]; bytes: Buffer }
/** Pi 0.73.1 / session v3 only. Fail closed on partial writes, branches or unknown schemas.
 * Never invoke SessionManager.open(): that API can migrate/write an old file. */
export function readSession(file: string, allowMissing = false): SessionSnapshot {
  if (allowMissing && !existsSync(file)) return { sessionId: null, entries: [], bytes: Buffer.alloc(0) };
  const fd = openSync(file,'r');
  let bytes: Buffer;
  try {
    if (fstatSync(fd).size > sessionLimit) throw new Error('SESSION_LIMIT');
    bytes = readFileSync(fd);
    if (bytes.length > sessionLimit) throw new Error('SESSION_LIMIT');
  } finally { closeSync(fd); }
  if (!bytes.length || bytes.at(-1) !== 10) throw new Error('SESSION_CORRUPT');
  const lines = new TextDecoder('utf-8',{ fatal:true }).decode(bytes).trimEnd().split('\n');
  const header = JSON.parse(lines.shift()!);
  if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string') throw new Error('SESSION_INCOMPATIBLE');
  const entries: SessionEntry[] = [], ids = new Set<string>();
  let parent: string | null = null;
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (!['message','model_change','thinking_level_change','custom','custom_message','session_info','label'].includes(entry.type)
      || typeof entry.id !== 'string' || ids.has(entry.id) || entry.parentId !== parent) throw new Error('SESSION_INCOMPATIBLE');
    if (entry.type === 'message' && (!entry.message || !['user','assistant','toolResult'].includes(entry.message.role))) throw new Error('SESSION_INCOMPATIBLE');
    ids.add(entry.id); parent = entry.id; entries.push(entry);
  }
  return { sessionId:header.id,entries,bytes };
}
export function projectionId(runId: string, key: string): string {
  const hex = digest(runId + ':' + key);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export const messageText = (message: any): string => typeof message.content === 'string' ? message.content :
  Array.isArray(message.content) ? message.content.filter((c: any) => c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('') : '';
export const displayLimit = 64 * 1024;
export function displayText(text: string): string {
  return text.length <= displayLimit ? text : text.slice(0,displayLimit) + '\n[展示截断；完整内容请核对原始 Pi 会话文件]';
}
