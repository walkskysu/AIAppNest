import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const spikeRoot = fileURLToPath(new URL('../', import.meta.url));
export function nativeEnv() {
  const temp = join(spikeRoot, '.runs/native-temp'); mkdirSync(temp, { recursive: true });
  return { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: temp, TMP: temp };
}
export function nativeHost() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 required');
  const source = join(spikeRoot, 'src/NativeHost.cs');
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 16);
  const dir = join(spikeRoot, '.runs/bin'); mkdirSync(dir, { recursive: true });
  const exe = join(dir, `native-${hash}.exe`);
  if (!existsSync(exe)) {
    const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/r:System.Security.dll', `/out:${exe}`, source], { shell: false, windowsHide: true, encoding: 'utf8', env: nativeEnv() });
    if (result.status !== 0) throw new Error(`Native helper compilation failed: ${result.stdout}`);
  }
  return exe;
}
export function spawnJob(executable, args, options) {
  return spawn(nativeHost(), ['job', String(process.pid), resolve(executable), ...args], { env: nativeEnv(), ...options, shell: false, windowsHide: true });
}
export function dpapi(mode, input) {
  if (!['protect', 'unprotect'].includes(mode)) throw new Error('Invalid DPAPI operation');
  const result = spawnSync(nativeHost(), [mode], { input: Buffer.from(input).toString('base64'), encoding: 'utf8', shell: false, windowsHide: true, env: nativeEnv() });
  if (result.status !== 0) throw new Error(`DPAPI failed (${result.stderr.trim() || 'helper unavailable'})`);
  return Buffer.from(result.stdout, 'base64');
}
export function saveCredential(path, secret) { writeFileSync(path, dpapi('protect', Buffer.from(secret))); }
export function readCredential(path) { return dpapi('unprotect', readFileSync(path)).toString('utf8'); }
