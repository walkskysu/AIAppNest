import os from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cli } from './config.mjs';
export function environment() {
  return { node: process.version, nodeAbi: process.versions.modules, sqlite: process.versions.sqlite,
    pi: JSON.parse(readFileSync(join(dirname(cli), '../package.json'), 'utf8')).version,
    cli: 'node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
    platform: process.platform, arch: process.arch, windows: os.version(), build: os.release(),
    cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    adapter: 'spike-v1', providerFixture: 'deterministic-v1' };
}
if (process.argv[1]?.endsWith('environment.mjs')) console.log(JSON.stringify(environment(), null, 2));
