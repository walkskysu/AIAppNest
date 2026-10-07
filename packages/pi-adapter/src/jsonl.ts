/** Bounded byte framing keeps split UTF-8 sequences intact and rejects invalid encoding. */
export class JsonlDecoder {
  private buffer = Buffer.alloc(0);
  private bytes = 0;
  constructor(private readonly receive: (value: any) => void, readonly maxBytes = 8 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start), end = lf < 0 ? chunk.length : lf;
      const part = chunk.subarray(start, end);
      const required = this.bytes + part.length;
      if (required > this.maxBytes) throw new Error('FRAME_LIMIT');
      if (required > this.buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(this.maxBytes, Math.max(required, this.buffer.length * 2, 4096)));
        this.buffer.copy(grown, 0, 0, this.bytes); this.buffer = grown;
      }
      part.copy(this.buffer, this.bytes); this.bytes = required;
      if (lf < 0) return;
      const line = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.bytes));
      this.bytes = 0;
      if (line.trim()) {
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw new Error('INVALID_FRAME');
        this.receive(value);
      }
      start = lf + 1;
    }
  }
  end(): void { if (this.bytes) throw new Error('TRUNCATED_FRAME'); }
}
