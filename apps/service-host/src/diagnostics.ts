import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '@aiappnest/domain';
import type { Storage } from '@aiappnest/storage';
import { diagnosticSchema } from '../../../packages/contracts/src/runs';

// No free-form strings from engines, tools, users, credentials or file paths cross this allowlist.
const errorCodes = new Set(['RECOVERY_REQUIRED','RECOVERY_QUEUE_CANCELLED','QUEUE_TIMEOUT','WORKER_FAILED','PROCESS_EXIT',
  'PROTOCOL_ERROR','RUN_TIMEOUT','START_TIMEOUT','COMMAND_TIMEOUT','MODEL_ERROR','INCOMPLETE_RESULT','MEMORY_PREPARATION_FAILED',
  'STORAGE_UNAVAILABLE','CONFIGURATION_UNAVAILABLE','EXTENSION_FAILED','SPAWN_FAILED','SESSION_INVALID','CANCELLED_WITH_ACTIVE_RUN']);
export function diagnostics(storage: Storage,run: Run,unsaved = false,logSaved = true) {
  const counts = new Map(storage.eventCounts(run.appId,run.id).map(r => [r.type,r.n]));
  const phases=new Map(storage.phaseDurations(run.appId,run.id).map(r=>[r.state,r.ms]));
  const completion = storage.latestEvent(run.appId,run.id,'run.completed')?.payload as any;
  const error = storage.latestEvent(run.appId,run.id,'engine.error')?.payload as any;
  const recovery = storage.latestEvent(run.appId,run.id,'recovery.result')?.payload as any;
  const exit = completion?.exitCode ?? error?.exitCode;
  return diagnosticSchema.parse({ runId:run.id,state:run.state,phase:run.phase,
    errorCategory:unsaved ? 'STORAGE_UNAVAILABLE':run.error ? errorCodes.has(run.error) ? run.error:'UNKNOWN':null,
    durations:{ queuedMs:Math.max(0,(run.startedAt ?? run.endedAt ?? Date.now())-run.createdAt),
      activeMs:run.startedAt === null ? null:Math.max(0,(run.endedAt ?? Date.now())-run.startedAt),
      startupMs:phases.get('starting') ?? 0,runningMs:phases.get('running') ?? 0,approvalMs:phases.get('waiting_approval') ?? 0 },
    exitCode:Number.isSafeInteger(exit) ? exit:null,usage:run.usage,cost:'unknown',
    permissions:{ waiting:counts.get('policy.waiting') ?? 0,resolved:counts.get('policy.resolved') ?? 0 },
    recoveryAction:['manual_retry','confirmed_completion'].includes(recovery?.action) ? recovery.action:'none',
    output:unsaved ? 'unavailable':completion?.output?.truncated || counts.has('engine.output.truncated') || counts.has('output.truncated') ? 'display_truncated':'projection',
    outputSource:!unsaved && completion?.output?.source==='pi_session_verified' ? 'pi_session_verified':'unavailable',fullOutputFile:null,
    storage:unsaved ? 'unsaved':'saved',logSaved,
  });
}
/** Three 256 KiB files, seven-day expiry, metadata only. Raw stdout is never a log. */
export class DiagnosticLog {
  saved = true;
  constructor(private storage: Storage,private maxBytes = 256 * 1024,private retentionMs = 7 * 86400000) { this.prune(); }
  private path(index: number) {
    const file = join(this.storage.paths.root,'logs',`recovery-${index}.jsonl`);
    this.storage.paths.assertManaged(file); return file;
  }
  private prune() {
    try { for (let i=0;i<3;i++) { const file=this.path(i); if (existsSync(file) && Date.now()-statSync(file).mtimeMs > this.retentionMs) unlinkSync(file); } }
    catch { this.saved=false; }
  }
  write(run: Run,unsaved = false) {
    try {
      this.prune();
      const line=JSON.stringify(diagnostics(this.storage,run,unsaved,true))+'\n';
      if (existsSync(this.path(0)) && statSync(this.path(0)).size+Buffer.byteLength(line)>this.maxBytes) {
        if (existsSync(this.path(2))) unlinkSync(this.path(2));
        for (let i=1;i>=0;i--) if (existsSync(this.path(i))) renameSync(this.path(i),this.path(i+1));
      }
      appendFileSync(this.path(0),line,{ mode:0o600 }); this.saved=true;
    } catch { this.saved=false; } // Separate from durable run outcome; expose diagnostic-log failure.
  }
}
