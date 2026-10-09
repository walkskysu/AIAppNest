import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createArchive } from '../../scripts/zip.mjs';

test('release: actual installer reads UTF-8 streamed archive and rejects payload hash corruption', async t => {
  const root = await mkdtemp(resolve('.test-release-zip-'));
  t.after(() => rm(root, {recursive: true, force: true, maxRetries: 10}));
  const source = join(root, 'source'), zip = join(root, 'payload.zip');
  await mkdir(join(source, '中文 空格'), {recursive: true});
  await writeFile(join(source, '中文 空格/data.bin'), randomBytes(1024 * 1024));
  await writeFile(join(source, 'empty'), '');
  await createArchive(source, zip);
  const checksum = createHash('sha256').update(await readFile(zip)).digest('hex');
  const compile = async (name, hash) => {
    const info = join(root, 'BuildInfo.cs'), output = join(root, name + '.exe');
    await writeFile(info, `static class BuildInfo { public const string Id = "fixture"; public const string Sha256 = "${hash}"; public const long RequiredBytes = 0; }`);
    execFileSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo','/platform:x64','/target:winexe',
      `/win32manifest:${resolve('scripts/windows/app.manifest')}`,'/r:System.Windows.Forms.dll','/r:Microsoft.CSharp.dll','/r:System.Core.dll',
      '/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll',`/resource:${zip},payload.zip`, `/out:${output}`, info, resolve('scripts/windows/Installer.cs')], {windowsHide: true, stdio: 'inherit'});
    return output;
  };
  execFileSync(await compile('valid', checksum), ['--verify-payload'], {windowsHide: true});
  const invalid = await compile('invalid', '0'.repeat(64));
  assert.throws(() => execFileSync(invalid, ['--verify-payload'], {windowsHide: true}), error => error.status === 1);
});
