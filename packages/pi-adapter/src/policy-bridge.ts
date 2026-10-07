import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { RunBoundary } from '../../policy/src/service';
import { JsonlDecoder } from './jsonl';
import { EngineError } from './types';

/** Private per-worker channel, never a renderer API. Scope is captured by the host. */
export class PolicyBridge {
  readonly path = `\\\\.\\pipe\\aiappnest-${randomUUID()}`;
  readonly token = randomBytes(32).toString('hex');
  private server?: Server;
  private sockets = new Set<Socket>();
  private authenticated = false;
  private closed = false;
  constructor(private readonly boundary: () => RunBoundary | undefined, private readonly fatal: () => void) {}
  async listen(): Promise<void> {
    this.server = createServer(socket => {
      if (this.sockets.size >= 4 || this.closed) { socket.destroy(); return; }
      this.sockets.add(socket);
      let authorized = false, active = 0;
      const timer = setTimeout(() => socket.destroy(), 3000);
      const decoder = new JsonlDecoder(value => {
        if (!authorized) {
          const candidate = Buffer.from(typeof value.token === 'string' ? value.token : '');
          if (this.authenticated || value.type !== 'hello' || candidate.length !== this.token.length
            || !timingSafeEqual(candidate, Buffer.from(this.token))) { socket.destroy(); return; }
          authorized = true; this.authenticated = true; clearTimeout(timer);
          socket.write('{"type":"ready"}\n'); return;
        }
        if (value.type !== 'call' || typeof value.id !== 'string' || value.id.length > 100 || ++active > 16) { socket.destroy(); return; }
        void this.call(value).then(result => {
          if (!socket.destroyed) socket.write(JSON.stringify({ type: 'result', id: value.id, ok: true, result }) + '\n');
        }, () => {
          if (!socket.destroyed) socket.write(JSON.stringify({ type: 'result', id: value.id, ok: false, error: 'POLICY_DENIED' }) + '\n');
        }).finally(() => { active--; });
      }, 2 * 1024 * 1024);
      socket.on('data', chunk => { try { decoder.push(chunk); } catch { socket.destroy(); } });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        clearTimeout(timer); this.sockets.delete(socket);
        if (authorized && !this.closed) this.fatal();
      });
    });
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.path, resolve); });
  }
  private async call(value: any): Promise<unknown> {
    const boundary = this.boundary();
    if (!boundary || this.closed || typeof value.callId !== 'string') throw new EngineError('INVALID_STATE');
    boundary.assertActive();
    switch (value.method) {
      case 'read': return boundary.read(value.callId, value.args);
      case 'list': return boundary.list(value.callId, value.args);
      case 'write': return boundary.write(value.callId, value.args);
      case 'output': return boundary.output(value.callId, value.args);
      case 'trusted': return boundary.trusted(value.callId, value.tool, value.args, async () => null);
      case 'reject': boundary.reject(value.tool, value.callId); return null;
      default: throw new EngineError('INVALID_INPUT');
    }
  }
  close(): void { this.closed = true; for (const socket of this.sockets) socket.destroy(); this.server?.close(); }
}
