import { cp, mkdir, readFile, writeFile, readdir, lstat, rename, rm } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createArchive } from './zip.mjs';

const output = resolve('release-output');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const run = (file, args, options = {}) => execFileSync(file, args, { windowsHide: true, stdio: 'inherit', ...options });
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== '24.19.0') throw Error('Pinned Windows x64 Node 24.19.0 required');
const pkg = await readJson('package.json'), lock = await readJson('package-lock.json');
for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || lock.packages[`node_modules/${name}`]?.version !== version) throw Error(`Unpinned dependency: ${name}`);
}
// All stages are new directories. Re-running never deletes a previous candidate or its evidence.
await mkdir(output, { recursive: true });
const work = join(output, 'candidate-' + new Date().toISOString().replace(/[:.]/g, '-'));
const desktop = join(work, 'app'), resources = join(desktop, 'resources/app');
await mkdir(resources, { recursive: true });
await cp('node_modules/electron/dist', desktop, { recursive: true });
await rm(join(desktop, 'resources/default_app.asar'), { force: true });
await rename(join(desktop, 'electron.exe'), join(desktop, 'AIAppNest.exe'));
run(process.execPath, ['scripts/build.mjs', `--out-dir=${resources}`]);
const notices = [], inventory = [];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || metadata.dev || metadata.link) continue;
  try { await lstat(path); } catch { if (metadata.optional) continue; throw Error(`Missing locked dependency: ${path}`); }
  const installed = await readJson(join(path, 'package.json'));
  if (installed.version !== metadata.version) throw Error(`Dependency drift: ${path}`);
  await cp(path, join(resources, path), { recursive: true, filter: async source => {
    const rel = relative(path, source);
    if (rel.split(/[\\/]/).includes('node_modules')) return false; // nested lock entries copied separately
    if ((await lstat(source)).isSymbolicLink()) throw Error(`Linked package file: ${source}`);
    return true;
  } });
  inventory.push({ path, version: metadata.version, license: metadata.license ?? installed.license ?? 'UNKNOWN', integrity: metadata.integrity });
  for (const name of await readdir(path)) if (/^(licen[sc]e|copying|notice)(\.|$)/i.test(name) && (await lstat(join(path, name))).isFile())
    notices.push(`\n--- ${path}@${metadata.version}/${name} ---\n${await readFile(join(path, name), 'utf8')}`);
}
// Include notices for bundled frontend/code dependencies too, not only the Pi tree.
for (const name of ['vue', '@vue/shared', '@vue/reactivity', '@vue/runtime-core', '@vue/runtime-dom', 'zod', 'yaml']) {
  const path = join('node_modules', name);
  for (const file of await readdir(path)) if (/^licen[sc]e/i.test(file) && (await lstat(join(path, file))).isFile()) notices.push(`\n--- bundled ${name}/${file} ---\n${await readFile(join(path, file), 'utf8')}`);
}
// Vendored from the exact Node source tag; release builds do not fetch notices dynamically.
const nodeLicenseText = await readFile('resources/licenses/Node-24.19.0-LICENSE.txt', 'utf8');
await writeFile(join(resources, 'THIRD-PARTY-NOTICES.txt'), `Node ${process.versions.node}\n${nodeLicenseText}\n${notices.join('\n')}`);
await writeFile(join(resources, 'dependency-inventory.json'), JSON.stringify(inventory, null, 2));
await cp('package-lock.json', join(resources, 'release-package-lock.json'));
const engine = await readJson(join(resources, 'engine-runtime.json'));
engine.cli = 'node_modules/@mariozechner/pi-coding-agent/dist/cli.js';
for (const name of ['node', 'cli', 'extension', 'nativeHost']) engine.hashes[name] = hash(await readFile(join(resources, engine[name])));
await writeFile(join(resources, 'engine-runtime.json'), JSON.stringify(engine, null, 2));
const metadata = JSON.parse(execFileSync(join(resources, 'runtime/node.exe'), [join(resources, 'release-cli.cjs'), 'metadata'], { encoding: 'utf8' }));
const identityFiles = ['package-lock.json','scripts/release-package.mjs','scripts/windows/Installer.cs', ...['main.cjs','service-host.cjs','platform-extension.mjs','preload.cjs','release-cli.cjs','renderer/index.html','runtime/node.exe','credential-host.exe','worker-host.exe','data-lease.exe'].map(file=>join(resources,file)), ...(await readdir(join(resources,'renderer/assets'))).sort().map(file=>join(resources,'renderer/assets',file))];
const identity = hash(Buffer.concat(await Promise.all(identityFiles.map(file=>readFile(file))))).slice(0, 16);
const manifest = { id: identity, version: '0.1.0-internal.' + identity, channel: 'internal-candidate', finalAcceptance: 'PENDING',
  platform: 'win32', arch: 'x64', electron: pkg.devDependencies.electron, node: process.versions.node, nodeABI: process.versions.modules,
  sqlite: process.versions.sqlite, credential: 'Windows DPAPI / .NET Framework x64 (no Node addon ABI)',
  runtime: engine.versions, schema: metadata.schema, lockSHA256: hash(await readFile('package-lock.json')), signature: 'UNSIGNED_INTERNAL_ONLY' };
await writeFile(join(resources, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
await cp('docs/release', join(desktop, 'docs'), { recursive: true });
// The shipped executable, sidecar and Pi tree must pass before producing an installer.
const gateOptions = {
  env: { ...process.env, AIAPPNEST_TEST_RUNTIME: resources, AIAPPNEST_TEST_EXECUTABLE: join(desktop, 'AIAppNest.exe') },
  encoding: 'utf8', maxBuffer: 8 * 1024 ** 2,
};
try {
  const log = execFileSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/integration/engine.test.mjs', 'tests/integration/release-package.test.mjs'], { ...gateOptions, windowsHide: true });
  await writeFile(join(work, 'package-gate.txt'), log);
  console.log(log);
} catch (error) {
  await writeFile(join(work, 'package-gate.txt'), String(error.stdout ?? '') + String(error.stderr ?? ''));
  throw Error(`Packaged runtime gate failed; no installer produced. Evidence: ${join(work, 'package-gate.txt')}`);
}
const csc = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const references = ['/nologo','/platform:x64','/target:winexe',`/win32manifest:${resolve('scripts/windows/app.manifest')}`,'/r:System.Windows.Forms.dll','/r:Microsoft.CSharp.dll','/r:System.Core.dll','/r:System.IO.Compression.dll','/r:System.IO.Compression.FileSystem.dll'];
run(csc, [...references, '/define:UNINSTALL', `/out:${join(desktop, 'Uninstall.exe')}`, resolve('scripts/windows/Installer.cs')]);
const files = {};
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), rel = relative(desktop, path).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw Error(`Linked artifact: ${rel}`);
    if (entry.isDirectory()) await scan(path);
    else {
      if (/(^|\/)(\.env(?:\..*)?|auth\.json|credentials|platform\.db(?:-wal|-shm)?|\.git|\.npmrc)(\/|$)/i.test(rel) || /\.(log|aibackup|pfx|p12)$/i.test(rel)) throw Error(`Forbidden package file: ${rel}`);
      const bytes = await readFile(path); files[rel] = { bytes: bytes.length, sha256: hash(bytes) };
    }
  }
}
await scan(desktop);
await writeFile(join(desktop, 'files.sha256.json'), JSON.stringify(files, null, 2));
const archive = join(work, `AIAppNest-${identity}-win-x64-internal.zip`);
await createArchive(desktop, archive);
const archiveHash = hash(await readFile(archive));
const generated = join(work, 'BuildInfo.cs');
await writeFile(generated, `static class BuildInfo { public const string Id = "${identity}"; public const string Sha256 = "${archiveHash}"; public const long RequiredBytes = ${Object.values(files).reduce((n, f) => n + f.bytes, 0) * 2 + 256 * 1024 ** 2}L; }`);
const installer = join(work, `AIAppNest-${identity}-win-x64-internal-setup.exe`);
run(csc, [...references, `/resource:${archive},payload.zip`, `/out:${installer}`, generated, resolve('scripts/windows/Installer.cs')]);
run(installer, ['--verify-payload']);
// Capture actual Authenticode status without claiming a signature or online
// reputation check. Never imports a certificate or reads a signing secret.
const signingScript = `$ErrorActionPreference = 'Stop'; $root = $env:AIAPPNEST_SIGNATURE_ROOT; $files = @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Extension -in '.exe','.dll','.node' }); $files += Get-Item -LiteralPath $env:AIAPPNEST_SIGNATURE_INSTALLER; @($files | ForEach-Object { $sig = Get-AuthenticodeSignature -LiteralPath $_.FullName; [pscustomobject]@{ file = $_.FullName.Substring($env:AIAPPNEST_SIGNATURE_WORK.Length + 1); status = [string]$sig.Status; signer = [string]$sig.SignerCertificate.Subject; thumbprint = [string]$sig.SignerCertificate.Thumbprint } }) | ConvertTo-Json -Depth 4`;
const signatures = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', signingScript], {
  windowsHide: true, encoding: 'utf8', env: { ...process.env, AIAPPNEST_SIGNATURE_ROOT: desktop, AIAPPNEST_SIGNATURE_INSTALLER: installer, AIAPPNEST_SIGNATURE_WORK: work }, maxBuffer: 4 * 1024 ** 2,
}));
await writeFile(join(work, 'signing-report.json'), JSON.stringify({ policy: 'UNSIGNED_INTERNAL_ONLY', formalSigningAcceptance: 'PENDING', signatures }, null, 2));
const checksums = `${hash(await readFile(installer))}  ${relative(work, installer)}\n${archiveHash}  ${relative(work, archive)}\n`;
await writeFile(join(work, 'SHA256SUMS.txt'), checksums);
await writeFile(join(work, 'candidate.json'), JSON.stringify({ ...manifest, createdAt: new Date().toISOString(),
  packageGate: 'PASS_DETERMINISTIC_MODEL', embeddedArchiveVerification: 'PASS', signingReport: 'signing-report.json', packagedFileCount: Object.keys(files).length, installer: relative(work, installer),
  publicRelease: false, finalAcceptance: 'PENDING', pending: ['L01-L10 manual acceptance','Clean Windows/new account','Real models','Authenticode/signing policy','Performance acceptance','Dependency audit resolution'] }, null, 2));
await writeFile(join(output, 'latest.json'), JSON.stringify({ directory: work, installer, archive }, null, 2));
console.log(`INTERNAL CANDIDATE ONLY: ${installer}\n${checksums}`);
