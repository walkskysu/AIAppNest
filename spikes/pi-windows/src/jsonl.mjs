// Decode complete LF-delimited byte frames, not individual chunks (UTF-8 may split).
export class JsonlDecoder {
  #buffer = Buffer.alloc(0);
  constructor(onValue, maxBytes = 8 * 1024 * 1024) { this.onValue = onValue; this.maxBytes = maxBytes; }
  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let index;
    while ((index = this.#buffer.indexOf(10)) !== -1) {
      if (index > this.maxBytes) throw new Error('JSONL frame too large');
      const line = this.#buffer.subarray(0, index); this.#buffer = this.#buffer.subarray(index + 1);
      if (line.toString('utf8').trim()) this.onValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
    }
    if (this.#buffer.length > this.maxBytes) throw new Error('JSONL frame too large');
  }
  end() { if (this.#buffer.length) throw new Error('Truncated JSONL frame'); }
}
