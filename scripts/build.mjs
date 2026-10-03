import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

if (process.versions.node !== '24.19.0') throw new Error('Build requires the pinned Node 24.19.0 sidecar runtime.');
const dev = process.argv.includes('--dev');
const outdir = resolve(process.argv.find((arg) => arg.startsWith('--out-dir='))?.slice(10) ?? 'dist');
await mkdir(resolve(outdir, 'runtime'), { recursive: true });
// esbuild does not remove maps left by an earlier development build.
if (!dev) {
  for (const name of ['main', 'preload', 'service-host', 'service-manager', 'provider-probe']) {
    await rm(resolve(outdir, `${name}.cjs.map`), { force: true });
  }
}
await copyFile(process.execPath, resolve(outdir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', sourcemap: dev, external: ['electron'], logLevel: 'warning' };
await build({ ...common, entryPoints: ['apps/desktop/src/main.ts'], outfile: `${outdir}/main.cjs`, define: { __DEV__: String(dev) } });
await build({ ...common, entryPoints: ['apps/desktop/src/preload.ts'], outfile: `${outdir}/preload.cjs` });
await build({ ...common, entryPoints: ['apps/service-host/src/index.ts'], outfile: `${outdir}/service-host.cjs` });
await build({ ...common, entryPoints: ['packages/pi-adapter/src/probe-worker.ts'], outfile: `${outdir}/provider-probe.cjs` });
if (process.platform === 'win32') {
  execFileSync(resolve(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:exe', '/platform:x64', '/r:System.Security.dll', `/out:${outdir}/credential-host.exe`,
    resolve('apps/service-host/src/CredentialHost.cs'),
  ], { windowsHide: true, stdio: 'pipe' });
}
// Standalone manager bundle for real Node child-process fault-injection tests.
await build({ ...common, entryPoints: ['apps/desktop/src/service-manager.ts'], outfile: `${outdir}/service-manager.cjs` });
await buildRenderer({ configFile: false, root: resolve('apps/desktop/renderer'), base: './',
  build: { outDir: resolve(outdir, 'renderer'), emptyOutDir: true, sourcemap: dev, target: 'es2022' },
});
await writeFile(`${outdir}/package.json`, JSON.stringify({ name: 'aiappnest-desktop', version: '0.0.0', main: 'main.cjs' }, null, 2));
console.log(`Built ${dev ? 'development' : 'production'} desktop and Node ${process.versions.node} sidecar.`);
