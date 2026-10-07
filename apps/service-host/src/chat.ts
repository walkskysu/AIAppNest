import { createHash, randomUUID } from 'node:crypto';
import { DomainError, id, timestamp, type Conversation } from '@aiappnest/domain';
import { chatRequestSchema, chatReplySchema, publicError, type ChatRequest, type ChatReply, type Result, type TrialView, type ErrorCode } from '@aiappnest/contracts';
import type { Storage } from '@aiappnest/storage';
import type { AppService } from './apps';
import type { RunScheduler } from './runs';
const view = ({ piSessionFile: _privatePath, ...conversation }: Conversation) => conversation;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** This boundary owns conversation routing. Renderer paths and success claims are never accepted. */
export class ChatService {
  constructor(private storage: Storage, private apps: AppService, private runs: RunScheduler) {}
  private draftHash(appId: string) { return hash(this.storage.appDraft(id<'app'>(appId)).config); }
  private trial(appId: string, trialId: string) {
    const row = this.storage.trialRows(id<'app'>(appId)).find(row => row.id === trialId);
    if (!row) throw new DomainError('NOT_FOUND');
    return row;
  }
  private trialView(row: ReturnType<ChatService['trial']>): TrialView {
    const revision = this.apps.readRevision(row.appId,row.revisionId);
    const profile = this.storage.providers.get({ id: id<'provider'>(revision.snapshot.credentialBinding) });
    return { id: row.id, appId: row.appId, conversationId: row.conversationId, revisionId: row.revisionId,
      configHash: revision.configHash, published: !!row.published,
      stale: row.draftHash !== this.draftHash(row.appId) || profile.revision !== revision.snapshot.config.model?.expectedRevision,
      run: this.storage.chatHistory(row.appId,row.conversationId,1,0).runs.at(-1) ?? null };
  }
  request(raw: unknown): Result<ChatReply> {
    const input = chatRequestSchema.safeParse(raw);
    if (!input.success) return { ok: false, error: publicError('INVALID_INPUT') };
    try { return { ok: true, value: chatReplySchema.parse(this.dispatch(input.data)) }; }
    catch (error) {
      const code = error instanceof DomainError ? error.code : 'STORAGE_UNAVAILABLE';
      return { ok: false, error: publicError((code === 'INVALID_TRANSITION' ? 'APP_UNAVAILABLE' : ['NOT_FOUND','VERSION_CONFLICT','INVALID_INPUT','BUSY','NOT_READY'].includes(code) ? code : 'STORAGE_UNAVAILABLE') as ErrorCode) };
    }
  }
  private dispatch(input: ChatRequest): ChatReply {
    const appId = id<'app'>(input.appId), app = this.storage.apps.get({ id: appId });
    if (input.operation === 'list') {
      const result = this.storage.chatList(appId,input.query,input.limit,input.offset);
      return { operation: input.operation, ...result, conversations: result.conversations.map(view) };
    }
    if (input.operation === 'trial.list') return { operation: input.operation, trials: this.storage.trialRows(appId).map(row => this.trialView(row)) };
    if (app.status === 'archived') throw new DomainError('INVALID_TRANSITION');
    if (input.operation === 'trial.start') {
      let row = this.storage.trialRows(appId).find(row => row.id === input.trialId);
      if (row && row.text !== input.text) throw new DomainError('VERSION_CONFLICT');
      if (!row) row = this.storage.transaction(() => {
        const revision = this.apps.createCandidate(appId,input.expectedVersion);
        const conversationId = id<'conversation'>(randomUUID()), now = timestamp();
        this.storage.conversations.insert({ id: conversationId, appId, revisionId: id<'revision'>(revision.id), title: '隔离试运行',
          piSessionFile: null, status: 'active', createdAt: now, updatedAt: now });
        this.storage.saveTrial({ id: input.trialId, appId, conversationId, revisionId: id<'revision'>(revision.id), draftHash: this.draftHash(appId), text: input.text });
        return this.trial(appId,input.trialId);
      });
      const result = this.runs.request({ operation: 'submit', appId, conversationId: row.conversationId, revisionId: row.revisionId,
        requestId: row.id, text: row.text, attachmentIds: [] });
      if (!result.ok) throw new DomainError(result.error.code as 'INVALID_INPUT');
      return { operation: input.operation, trial: this.trialView(row) };
    }
    if (input.operation === 'trial.publish') {
      this.storage.transaction(() => {
        const row = this.trial(appId,input.trialId), trial = this.trialView(row);
        // A lost publish response can be retried even with the original expectedVersion.
        if (row.published) return;
        if (trial.stale || trial.run?.state !== 'succeeded') throw new DomainError('VERSION_CONFLICT');
        this.apps.resolveSkills(appId,row.revisionId);
        this.storage.activateTrial(appId,row.id,row.revisionId,input.expectedVersion);
      });
      const result = this.apps.request({ operation: 'get', appId });
      if (!result.ok || !('app' in result.value)) throw new DomainError('STORAGE_UNAVAILABLE');
      return { operation: input.operation, app: result.value.app };
    }
    const conversationId = id<'conversation'>(input.conversationId);
    if (input.operation === 'create') {
      const conversation = this.storage.transaction(() => {
        try { return this.storage.conversations.get({ appId, id: conversationId }); }
        catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
        if (app.status !== 'ready') throw new DomainError('INVALID_TRANSITION');
        return this.storage.createConversation(appId,conversationId,input.title);
      });
      return { operation: input.operation, conversation: view(conversation) };
    }
    this.storage.conversations.get({ appId, id: conversationId });
    if (input.operation === 'history') {
      const result = this.storage.chatHistory(appId,conversationId,input.limit,input.offset);
      return { operation: input.operation, ...result, conversation: view(result.conversation) };
    }
    if (input.operation === 'rename') return { operation: input.operation, conversation: view(this.storage.renameConversation(appId,conversationId,input.title)) };
    // Seal admission immediately, then report termination separately; the UI polls explicitly.
    const terminated = this.runs.retireConversation(appId,conversationId);
    if (terminated) this.storage.recycleConversation(appId,conversationId);
    return { operation: 'delete', terminated, archived: terminated };
  }
}
