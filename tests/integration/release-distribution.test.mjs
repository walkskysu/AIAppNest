import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// The mandatory full suite also produces the internal acceptance artifact. The
// builder runs only engine + package probes, never recursively invokes this suite.
test('release distribution: produce installer only after actual packaged runtime gates', { timeout: 600000 }, async () => {
  await promisify(execFile)(process.execPath, ['scripts/release-package.mjs'], { windowsHide: true, maxBuffer: 8 * 1024 ** 2 });
  const latest = JSON.parse(await readFile('release-output/latest.json', 'utf8'));
  const candidate = JSON.parse(await readFile(join(latest.directory, 'candidate.json'), 'utf8'));
  assert.equal(candidate.publicRelease, false);
  assert.equal(candidate.finalAcceptance, 'PENDING');
  assert.equal(candidate.packageGate, 'PASS_DETERMINISTIC_MODEL');
  const sums = await readFile(join(latest.directory, 'SHA256SUMS.txt'), 'utf8');
  for (const line of sums.trim().split('\n')) {
    const [hash, name] = line.split('  ');
    assert.equal(createHash('sha256').update(await readFile(join(latest.directory, name))).digest('hex'), hash);
  }
});
