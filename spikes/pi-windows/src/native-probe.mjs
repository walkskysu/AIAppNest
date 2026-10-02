import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spikeRoot, saveCredential, readCredential } from './native.mjs';
export async function nativeProbe() {
  await mkdir(join(spikeRoot, '.runs'), { recursive: true });
  const dir = await mkdtemp(join(spikeRoot, '.runs/native-probe-'));
  const result = { dpapi: 'BLOCKED', sqlite: 'FAIL' };
  try {
    const marker = 'non-sensitive-native-probe'; const path = join(dir, 'credential.bin');
    saveCredential(path, marker);
    if (readCredential(path) !== marker || (await readFile(path)).includes(Buffer.from(marker))) throw new Error('roundtrip');
    result.dpapi = 'PASS';
  } catch { result.dpapi = 'BLOCKED'; }
  const db = new DatabaseSync(join(dir, 'probe.db'));
  try { db.exec('CREATE TABLE probe(value TEXT)'); db.prepare('INSERT INTO probe VALUES (?)').run('中文'); result.sqlite = db.prepare('SELECT value FROM probe').get().value === '中文' ? 'PASS' : 'FAIL'; }
  finally { db.close(); }
  return result;
}
if (process.argv[1]?.endsWith('native-probe.mjs')) {
  const result = await nativeProbe(); console.log(JSON.stringify(result));
  if (Object.values(result).some(v => v !== 'PASS')) process.exitCode = 2;
}
