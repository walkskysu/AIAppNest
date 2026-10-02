import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('F14 production rebuild removes all development source maps', { timeout: 60000 }, async () => {
  const root = await mkdtemp(resolve('.test-dev-'));
  const build = (...args) => promisify(execFile)(process.execPath, ['scripts/build.mjs', `--out-dir=${root}`, ...args]);
  try {
    await build('--dev');
    assert.ok((await readdir(root)).includes('main.cjs.map'));
    await build();
    const files = await readdir(root, { recursive: true });
    assert.deepEqual(files.filter((file) => file.endsWith('.map')), []);
    for (const file of files.filter((file) => /\.(cjs|js|css)$/.test(file))) {
      assert.doesNotMatch(await readFile(join(root, file), 'utf8'), /sourceMappingURL=/);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
