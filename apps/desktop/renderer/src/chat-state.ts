import type { RunReply } from '@aiappnest/contracts';
export type RunView = Extract<RunReply, { operation: 'get' }>['run'];
export type EventView = Extract<RunReply, { operation: 'next' | 'subscribe' }>['events'][number];
export const terminal = (run: RunView) => ['succeeded','failed','cancelled','interrupted','handled'].includes(run.state);
export const stateNames: Record<RunView['state'], string> = { queued: '正在排队', starting: '正在启动', running: '正在执行',
  waiting_approval: '等待确认', cancelling: '正在停止', succeeded: '已完成', failed: '执行失败', cancelled: '已停止', interrupted: '执行中断', handled: '命令已处理' };
/** Only contiguous events advance the cursor. Replays never append deltas twice. */
export class RunFeed {
  seq = 0;
  text = '';
  tools = new Map<string, { name: string; result?: string }>();
  constructor(readonly runId: string) {}
  merge(events: EventView[]) {
    for (const event of [...events].sort((a,b) => a.seq - b.seq)) {
      if (event.runId !== this.runId || event.seq <= this.seq) continue;
      if (event.seq !== this.seq + 1) break;
      this.seq = event.seq;
      const p = event.payload as Record<string, unknown> | null;
      if (event.type === 'engine.assistant.delta' && typeof p?.text === 'string') this.text += p.text;
      if (event.type.startsWith('engine.tool.') && typeof p?.callId === 'string') this.tools.set(p.callId,
        { name: String(p.name ?? '工具'), ...(event.type === 'engine.tool.result' ? { result: JSON.stringify(p.result) } : {}) });
    }
  }
}
export const shouldSubmit = (event: Pick<KeyboardEvent,'key'|'shiftKey'|'isComposing'|'keyCode'>, composing: boolean) =>
  event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229;
export function safeExternal(raw: string): string | null {
  try { const url = new URL(raw); return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
