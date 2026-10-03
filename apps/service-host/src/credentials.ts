import { spawnSync } from 'node:child_process';
import { openSync, writeFileSync, fsyncSync, closeSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataPaths } from '@aiappnest/storage';

export class CredentialError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE';
  constructor() { super('CREDENTIAL_UNAVAILABLE'); }
}
export interface CredentialStore {
  create(key: string): string;
  read(ref: string): string;
  remove(ref: string): void;
  collect(liveRefs: Set<string>): boolean;
}
export class CredentialService implements CredentialStore {
  private readonly directory: string;
  constructor(private readonly paths: DataPaths, private readonly helper: string) {
    this.directory = join(paths.root, 'credentials');
  }
  private file(ref: string): string {
    if (!/^secret:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ref)) throw new CredentialError();
    const path = join(this.directory, `${ref.slice(7)}.bin`);
    this.paths.assertManaged(path);
    return path;
  }
  private crypt(mode: 'protect' | 'unprotect', bytes: Buffer): Buffer {
    if (process.platform !== 'win32') throw new CredentialError();
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    try {
      const result = spawnSync(this.helper, [mode], { input: bytes.toString('base64'), encoding: 'utf8',
        shell: false, windowsHide: true, env, timeout: 5000, maxBuffer: 65536 });
      if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout)) throw new CredentialError();
      return Buffer.from(result.stdout, 'base64');
    } catch { throw new CredentialError(); }
    finally { bytes.fill(0); }
  }
  create(key: string): string {
    const ref = `secret:${randomUUID()}`;
    try {
      const encrypted = this.crypt('protect', Buffer.from(key));
      this.paths.ensureDirectory(this.directory);
      const descriptor = openSync(this.file(ref), 'wx', 0o600);
      try { writeFileSync(descriptor, encrypted); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      return ref;
    } catch {
      try { this.remove(ref); } catch { /* startup collection retries orphan removal */ }
      throw new CredentialError();
    }
  }
  read(ref: string): string {
    try {
      const file = this.file(ref);
      if (statSync(file).size > 32768) throw new CredentialError();
      const plain = this.crypt('unprotect', readFileSync(file));
      try {
        const key = plain.toString('utf8');
        if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new CredentialError();
        return key;
      } finally { plain.fill(0); }
    } catch { throw new CredentialError(); }
  }
  remove(ref: string): void {
    try { unlinkSync(this.file(ref)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CredentialError(); }
  }
  /** Ciphertext written before a failed/crashed DB commit is safe to collect on startup. */
  collect(liveRefs: Set<string>): boolean {
    try {
      this.paths.assertManaged(this.directory);
      let pending = false;
      for (const name of readdirSync(this.directory)) {
        if (!/^[0-9a-f-]{36}\.bin$/.test(name)) continue;
        const ref = `secret:${name.slice(0, -4)}`;
        if (!liveRefs.has(ref)) try { this.remove(ref); } catch { pending = true; }
      }
      return pending;
    } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  }
}
