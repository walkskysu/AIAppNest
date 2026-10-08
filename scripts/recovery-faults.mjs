import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// All injection targets are fresh test fixtures. No production profile, model or system sleep is touched.
const startedAt=new Date().toISOString();
const child=spawn(process.execPath,['--test','--test-concurrency=1','tests/integration/recovery.test.mjs'],{ stdio:'inherit',windowsHide:true });
const exitCode=await new Promise(resolve=>child.once('close',resolve));
const evidence={ issue:17,reference:'Refs #17',startedAt,finishedAt:new Date().toISOString(),platform:process.platform,node:process.versions.node,
  command:'npm run recovery:verify',exitCode,fixtureSuite:exitCode===0 ? 'PASS':'FAIL',model:'DETERMINISTIC_HTTP_FIXTURE',
  cases:{ X01:'fixture event replay + Electron coverage in desktop.test.mjs',X02:'fixture cursor gaps/duplicates/subscription cleanup',
    X03:'real Windows WorkerHost termination and creation-identity mismatch',X04:'real Service Host termination and restart; no replay',
    X05:'real Pi JSONL + SQLite projection deletion and repeat repair',X06:'corrupt/version-incompatible copies, byte preservation',
    X07:'SIMULATED_CLOCK_ONLY; ACTUAL_SLEEP_PENDING',X08:'real Pi large fixture output + bounded UI reducer',
    X09:'injected durable-write failure + real SQLite page quota; PHYSICAL_RESTRICTED_VOLUME_PENDING',
    X10:'sensitive markers excluded from allowlisted diagnostic and rotated logs',X11:'usage absent and no price configuration => unknown' },
  pending:['Engine E01/E05/E06/E09 real model','Chat C01 real model + C01-C10 manual','File real model + F01-F10 acceptance',
    'Memory M01-M10 real model/storage + manual','Recovery actual Windows sleep/wake','Recovery physical restricted disk volume',
    'Recovery UI manual acceptance'],finalAcceptance:'PENDING',draftRequired:true };
writeFileSync(resolve('docs/technical/evidence/recovery-windows-validation.json'),JSON.stringify(evidence,null,2)+'\n');
process.exitCode=exitCode ?? 1;
