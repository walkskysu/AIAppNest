import electron from 'electron';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
// Do not inherit model keys or Node/Electron injection options into desktop children.
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'DISPLAY', 'XAUTHORITY', 'LANG']) {
  if (process.env[key]) env[key] = process.env[key];
}
const child = spawn(electron, [resolve('dist')], { env, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Unable to start Electron. Run npm ci and npm run build.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
