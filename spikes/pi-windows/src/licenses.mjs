import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spikeRoot } from './native.mjs';
const repo = resolve(spikeRoot, '../..');
const lock = JSON.parse(await readFile(join(repo, 'package-lock.json'), 'utf8'));
const packages = Object.entries(lock.packages).filter(([name]) => name).map(([path, value]) => ({
  path, version: value.version, license: value.license ?? 'UNKNOWN', source: value.resolved, integrity: value.integrity,
  optional: value.optional === true,
}));
const path = resolve(process.argv[2] ?? join(spikeRoot, '.runs/license-inventory.json'));
await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ source: 'package-lock.json metadata; not a shipped notice bundle', packages }, null, 2) + '\n');
console.log(JSON.stringify({ packages: packages.length, unknown: packages.filter(p => p.license === 'UNKNOWN').length }));
