import { id, DomainError, timestamp, type Run } from '@aiappnest/domain';
import type { Storage } from '@aiappnest/storage';
import { digest, displayText, messageText, projectionId, readSession } from '../../../packages/pi-adapter/src/session-reader';

export type RepairStatus = 'repaired' | 'unchanged' | 'no_boundary' | 'no_session' | 'session_invalid' | 'busy';
interface Boundary { sessionId: string | null; leaf: string | null; bytes: number; hash: string; inputHash: string }
export class Recovery {
  constructor(private storage: Storage) {}
  private file(run: Run) {
    const file = this.storage.conversations.get({ appId:run.appId,id:run.conversationId }).piSessionFile;
    if (file) this.storage.paths.assertManaged(file);
    return file;
  }
  /** Write the exact session boundary before dispatch, without saving wrapped prompt/memory. */
  beforePrompt(run: Run, input: string) {
    const file = this.file(run);
    if (!file) return; // Injected test workers / legacy records have no recoverable boundary.
    const snapshot = readSession(file,true);
    this.storage.appendEvent(run.appId,run.id,'recovery.boundary',{
      sessionId:snapshot.sessionId,leaf:snapshot.entries.at(-1)?.id ?? null,bytes:snapshot.bytes.length,
      hash:digest(snapshot.bytes),inputHash:digest(input),
    });
  }
  private records(run: Run) {
    const boundary = this.storage.latestEvent(run.appId,run.id,'recovery.boundary')?.payload as Boundary | undefined;
    if (!boundary) return { status:'no_boundary' as const, entries:[] };
    const file = this.file(run);
    if (!file) return { status:'no_session' as const, entries:[] };
    const snapshot = readSession(file,true);
    if (snapshot.sessionId === null) return { status:'no_session' as const,entries:[] };
    if ((boundary.sessionId !== null && boundary.sessionId !== snapshot.sessionId) || snapshot.bytes.length < boundary.bytes
      || digest(snapshot.bytes.subarray(0,boundary.bytes)) !== boundary.hash) throw new Error('SESSION_CHANGED');
    const index = boundary.leaf === null ? -1 : snapshot.entries.findIndex(e => e.id === boundary.leaf);
    if (boundary.leaf !== null && index < 0) throw new Error('SESSION_CHANGED');
    const tail=snapshot.entries.slice(index+1);
    const marker=tail.findIndex(e=>e.type==='custom' && e.customType==='aiappnest-run' && e.data?.runId===run.id && e.data?.inputHash===boundary.inputHash);
    const marked=marker<0 ? tail:tail.slice(marker+1);
    const nextMarker=marked.findIndex(e=>e.type==='custom' && e.customType==='aiappnest-run');
    const entries = (nextMarker<0 ? marked:marked.slice(0,nextMarker)).filter(e => e.type === 'message');
    const first = entries.shift();
    // Engine marker also binds expanded Skills; legacy boundaries require an exact user hash.
    if (!first) return { status:'unchanged' as const, entries:[] };
    if (first.message.role !== 'user' || (marker<0 && digest(messageText(first.message)) !== boundary.inputHash)) throw new Error('SESSION_CHANGED');
    const nextUser = entries.findIndex(e => e.message.role === 'user');
    const owned=nextUser < 0 ? entries : entries.slice(0,nextUser),calls=new Set<string>();
    for (const entry of owned) {
      const m=entry.message;
      if (m.role==='assistant' && Array.isArray(m.content)) for (const c of m.content) {
        if (c.type==='toolCall') { if (typeof c.id!=='string' || calls.has(c.id)) throw new Error('SESSION_INVALID');calls.add(c.id); }
      }
      if (m.role==='toolResult' && (typeof m.toolCallId!=='string' || !calls.delete(m.toolCallId))) throw new Error('SESSION_INVALID');
    }
    return { status:'unchanged' as const, entries:owned };
  }
  /** A stop message alone does not prove tool completion/idle. Persist the adapter's barrier evidence. */
  witness(run: Run, state: string, usage: Run['usage']) {
    if (state !== 'succeeded') return;
    let records;
    try { records = this.records(run); } catch { return; }
    const last = records.entries.at(-1);
    if (last?.message.role === 'assistant' && last.message.stopReason === 'stop') {
      this.storage.appendEvent(run.appId,run.id,'recovery.completion',{
        entryId:last.id,hash:digest(JSON.stringify(last.message)),idle:true,toolErrors:0,usage,
      });
    }
  }
  repair(run: Run): { status: RepairStatus; inserted: number; confirmed: boolean; truncated: boolean; source:'pi_session_verified'|'unavailable' } {
    let records;
    try { records = this.records(run); }
    catch { return { status:'session_invalid',inserted:0,confirmed:false,truncated:false,source:'unavailable' }; }
    const proof = this.storage.latestEvent(run.appId,run.id,'recovery.completion')?.payload as any;
    const last = records.entries.at(-1);
    const confirmed = !!last && last.message.role === 'assistant' && last.message.stopReason === 'stop'
      && proof?.idle === true && proof.toolErrors === 0 && proof.entryId === last.id && proof.hash === digest(JSON.stringify(last.message));
    let inserted = 0;
    this.storage.transaction(() => {
      for (const entry of records.entries) {
        const m = entry.message;
        if (m.role === 'assistant' && !['stop','toolUse'].includes(m.stopReason)) continue;
        if (!['assistant','toolResult'].includes(m.role)) continue;
        if (m.role === 'toolResult' && typeof m.toolCallId !== 'string') throw new DomainError('INVALID_INPUT');
        const messageId = id<'message'>(projectionId(run.id,m.role === 'toolResult' ? 'tool:'+m.toolCallId : 'message:'+entry.id));
        try { this.storage.messages.get({ appId:run.appId,id:messageId }); continue; }
        catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
        const text = messageText(m);
        if (!text && m.role === 'assistant') continue;
        this.storage.messages.insert({ id:messageId,appId:run.appId,conversationId:run.conversationId,runId:run.id,
          role:m.role === 'toolResult' ? 'tool' : 'assistant',content:displayText(text),status:m.isError ? 'failed':'complete',createdAt:timestamp() });
        inserted++;
      }
    });
    return { status:inserted ? 'repaired':records.status,inserted,confirmed,
      truncated:records.entries.some(e=>messageText(e.message).length>65536),source:records.entries.length ? 'pi_session_verified':'unavailable' };
  }
  reconcile() {
    // Admission is unavailable until this synchronous startup pass finishes. Nothing is re-enqueued.
    for (const run of this.storage.unfinishedRuns()) {
      this.storage.appendEvent(run.appId,run.id,'recovery.pending',{ phase:run.phase });
      const report = run.state === 'queued' ? { status:'no_boundary',inserted:0,confirmed:false } : this.repair(run);
      this.storage.transaction(() => {
        const state = run.state === 'queued' ? 'cancelled' : run.state === 'running' && report.confirmed ? 'succeeded' : 'interrupted';
        const error = state === 'succeeded' ? null : run.state === 'queued' ? 'RECOVERY_QUEUE_CANCELLED' : 'RECOVERY_REQUIRED';
        const proof = this.storage.latestEvent(run.appId,run.id,'recovery.completion')?.payload as { usage?: Run['usage'] } | undefined;
        this.storage.transitionRun(run.appId,run.id,run.version,state,timestamp(),error,state === 'succeeded' ? proof?.usage ?? null : null);
        this.storage.appendEvent(run.appId,run.id,'recovery.result',{ ...report,action:state === 'succeeded' ? 'confirmed_completion':'manual_retry',
          process:'prior_generation_not_adopted',reason:run.state === 'queued' ? 'queue_not_replayed':report.status === 'session_invalid' ? 'session_invalid':'host_restart' });
        this.storage.appendEvent(run.appId,run.id,'run.completed',{ state,error });
      });
    }
  }
}
