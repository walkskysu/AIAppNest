import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DataPaths } from '@aiappnest/storage';

/** All Service Hosts and maintenance commands share a Windows exclusive file handle. */
export async function acquireDataLease(root: string, helper: string, onLost: () => void = () => process.exit(1)): Promise<() => void> {
  const path = root + '.lease';
  new DataPaths(dirname(root)).assertManaged(path);
  mkdirSync(dirname(root), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [path], { windowsHide: true, shell: false,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('DATA_ROOT_BUSY')); }, 5000);
    let ready = false, released = false;
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('DATA_ROOT_BUSY')); });
    child.once('exit', () => { clearTimeout(timer); if (!ready) reject(new Error('DATA_ROOT_BUSY')); else if (!released) onLost(); });
    child.stdout.once('data', bytes => {
      clearTimeout(timer);
      if (String(bytes).trim() !== 'LOCKED') { child.kill(); reject(new Error('DATA_ROOT_BUSY')); return; }
      ready = true;
      resolve(() => { released = true; child.stdin.end(); });
    });
  });
}
