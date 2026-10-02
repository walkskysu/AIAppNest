import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { shell: false, windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot } });
writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
