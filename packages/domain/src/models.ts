declare const identity: unique symbol;
export type Id<K extends string> = string & { readonly [identity]: K };
export type AppId = Id<'app'>;
export type RevisionId = Id<'revision'>;
export type SkillId = Id<'skill'>;
export type ConversationId = Id<'conversation'>;
export type RunId = Id<'run'>;
export type MessageId = Id<'message'>;
export type MemoryId = Id<'memory'>;
export type ArtifactId = Id<'artifact'>;
export type ProviderId = Id<'provider'>;
export type GrantId = Id<'grant'>;
export type RequestId = Id<'request'>;
/** UTC Unix epoch milliseconds, serialized as a safe integer (never local time). */
export type Timestamp = number & { readonly [identity]: 'timestamp' };
export type AppStatus = 'draft' | 'ready' | 'archived';
export type ConversationStatus = 'active' | 'archived';
export type MessageStatus = 'streaming' | 'complete' | 'failed';
export type RunState = 'queued' | 'starting' | 'running' | 'waiting_approval' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'handled';
export type ExecutionPhase = 'created' | 'started' | 'accepted' | 'completed';
export type MemoryStatus = 'candidate' | 'active' | 'conflict' | 'disabled' | 'deleted';
export interface App {
  id: AppId; name: string; description: string; icon: string | null; status: AppStatus;
  currentRevisionId: RevisionId | null; version: number; createdAt: Timestamp; updatedAt: Timestamp;
}
export interface RevisionConfig {
  schemaVersion: 1; modelId: string;
  memory: { enabled: boolean; maxItems: number; tokenBudget: number };
  permissions: { mode: 'chat' | 'controlled-files' | 'trusted-automation'; shell: boolean };
}
/** Published configuration is immutable. Editable drafts are stored separately. */
export interface AppRevision {
  id: RevisionId; appId: AppId; revision: number; providerProfileId: ProviderId;
  config: RevisionConfig | import('./app-config').AppConfig; roleText: string; runtimeVersion: string; createdAt: Timestamp;
}
export interface Skill {
  id: SkillId; version: string; hash: string; sourcePath: string;
  metadata: { name: string; description: string }; importedAt: Timestamp;
}
export interface AppSkill { revisionId: RevisionId; skillId: SkillId; skillVersion: string; enabled: boolean }
export interface Conversation {
  id: ConversationId; appId: AppId; revisionId: RevisionId; title: string;
  /** Null until Pi has returned its authoritative session file. */
  piSessionFile: string | null; status: ConversationStatus; createdAt: Timestamp; updatedAt: Timestamp;
}
export interface Run {
  id: RunId; appId: AppId; conversationId: ConversationId; requestId: RequestId;
  state: RunState; phase: ExecutionPhase; version: number; createdAt: Timestamp;
  startedAt: Timestamp | null; endedAt: Timestamp | null; error: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}
export interface Message {
  id: MessageId; appId: AppId; conversationId: ConversationId; runId: RunId | null;
  role: 'user' | 'assistant' | 'tool' | 'system'; content: string; status: MessageStatus; createdAt: Timestamp;
}
export interface RunEvent { runId: RunId; seq: number; type: string; payload: unknown; createdAt: Timestamp }
/** Each row is an immutable version. A new version supersedes the previous one. */
export interface Memory {
  id: MemoryId; appId: AppId; version: number; type: 'preference' | 'fact' | 'convention' | 'term';
  content: string; priority?: number; status: MemoryStatus; confidence: number | null;
  sourceConversationId: ConversationId | null; sourceRunId: RunId | null; sourceMessageId: MessageId | null;
  createdAt: Timestamp; updatedAt: Timestamp; expiresAt: Timestamp | null;
}
export interface RunMemoryLink { runId: RunId; appId: AppId; memoryId: MemoryId; memoryVersion: number; injectedTextHash: string; position?: number }
export interface Attachment {
  id: Id<'attachment'>; appId: AppId; conversationId: ConversationId;
  relativePath: string; displayName: string; mimeType: string; size: number; hash: string; createdAt: Timestamp;
}
export interface Artifact {
  displayName?: string; sourceKey?: string;
  id: ArtifactId; appId: AppId; conversationId: ConversationId; runId: RunId;
  relativePath: string; mimeType: string; size: number; hash: string; createdAt: Timestamp;
}
export interface ProviderProfile {
  id: ProviderId; name: string; providerType: string; endpoint: string; modelId: string;
  authMode: 'api-key' | 'none'; secretRef: string | null; revision: number;
  settings: { timeoutMs: number }; createdAt: Timestamp; updatedAt: Timestamp;
}
export interface Grant { id: GrantId; appId: AppId; capability: string; resource: string; mode: 'read' | 'write' | 'execute'; createdAt: Timestamp }
