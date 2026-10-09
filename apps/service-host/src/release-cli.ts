import { join, resolve } from 'node:path';
import { acquireDataLease } from './data-lease';
import { rollbackPlan, rollbackRelease } from './release';
import { migrations } from '../../../packages/storage/src/migrations';

async function main() {
  const [command, input, snapshot] = process.argv.slice(2);
  if (command === 'metadata') { console.log(JSON.stringify({ schema: migrations.length })); return; }
  if (!input || !['plan', 'rollback'].includes(command ?? '')) throw new Error('INVALID_COMMAND');
  const root = resolve(input), release = await acquireDataLease(root, join(__dirname, 'data-lease.exe'));
  if (command === 'rollback' && !snapshot) { release(); throw new Error('CONFIRMED_SNAPSHOT_REQUIRED'); }
  try { console.log(JSON.stringify(command === 'plan' ? rollbackPlan(root) : { directory: await rollbackRelease(root, snapshot) })); }
  finally { release(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'RELEASE_FAILED'); process.exitCode = 1; });
