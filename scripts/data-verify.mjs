import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Fresh fixture directories only; never opens a user's profile or calls a real model.
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'tests/integration/data.test.mjs'], {
  stdio: 'inherit', windowsHide: true,
});
const exitCode = await new Promise(resolve => child.once('close', resolve));
const evidence = {
  issue: 19, reference: 'Refs #19', startedAt, finishedAt: new Date().toISOString(),
  platform: process.platform, node: process.versions.node, command: 'npm run data:verify', exitCode,
  automaticSuite: exitCode === 0 ? 'PASS' : 'FAIL', model: 'DETERMINISTIC_HTTP_FIXTURE',
  independentDirectoryRestore: exitCode === 0 ? 'PASS_REAL_SQLITE_FILES_PI_SESSION' : 'NOT_CERTIFIED',
  cases: {
    B01: 'real scheduler/SQLite WAL; controlled extraction and in-flight write barriers; cancellation and copy fault',
    B02: 'real raw Pi JSONL, attachments, artifacts, Skill and memory in a fresh directory',
    B03: 'Chinese/spaced root; exact session mapping; rebind and actual Pi continuation with fixture model',
    B04: 'credential markers absent from package bytes; secretRef cleared and grants absent',
    B05: 'missing/hash/traversal/case alias/runtime/quota/link/reference failures rejected',
    B06: 'injected staging migration/publication failure preserves live root',
    B07: 'injected pointer interruption; old/new complete root selection; invalid marker fallback',
    B08: 'conversation/app recycle, independent recycle state, index rebuild, unarchive bypass rejected',
    B09: 'raw file purge; external originals/backups and other recycled app Skill preserved; source tombstones',
    B10: 'injected file and post-metadata Skill failure; persistent idempotent retry after service restart',
    B11: 'NEW_WINDOWS_ACCOUNT_PENDING',
  },
  simulatedFaults: ['copy failure', 'migration failure', 'publication failure', 'pointer interruption', 'file deletion denial'],
  pending: [
    'B01-B11 manual desktop acceptance and independent new Windows account restore drill',
    'Real-model original session/artifact restore and credential/external-directory rebinding',
    '#18 real model and H01-H11 manual acceptance',
    '#17 actual Windows sleep/wake, physical restricted volume and manual UI acceptance',
    'Earlier Engine/Chat/File/Memory real-model and manual acceptance',
  ],
  finalAcceptance: 'PENDING', draftRequired: true,
};
writeFileSync(resolve('docs/technical/evidence/data-windows-validation.json'), JSON.stringify(evidence, null, 2) + '\n');
process.exitCode = exitCode ?? 1;
