import { spawnJob } from '../src/native.mjs';
import { fileURLToPath } from 'node:url';
// stdin is deliberately kept open in the child: Job watcher must notice actual host death.
spawnJob(process.execPath, [fileURLToPath(new URL('./process-tree.mjs', import.meta.url)), process.argv[2]], { stdio: 'ignore' });
setInterval(() => {}, 1000);
