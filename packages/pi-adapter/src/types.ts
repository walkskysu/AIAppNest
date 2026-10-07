export const ENGINE_VERSION = Object.freeze({ node: '24.19.0', pi: '0.73.1', adapter: 'engine-v1', extension: 'policy-v1', session: 3 });
export type EngineErrorCode = 'INVALID_STATE' | 'INVALID_INPUT' | 'RESOURCE_INVALID' | 'VERSION_MISMATCH' | 'SESSION_INVALID'
  | 'MAPPING_FAILED' | 'START_TIMEOUT' | 'COMMAND_TIMEOUT' | 'RUN_TIMEOUT' | 'PROTOCOL_ERROR' | 'PROCESS_EXIT'
  | 'SPAWN_FAILED' | 'EXTENSION_FAILED' | 'MODEL_ERROR' | 'INCOMPLETE_RESULT' | 'CLOSE_TIMEOUT';
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, readonly exitCode: number | null = null, readonly signal: string | null = null) {
    super(code); this.name = 'EngineError';
  }
}
export interface EngineScope { appId: string; conversationId: string; revisionId: string }
export interface EngineEvent extends EngineScope {
  seq: number; runId: string | null;
  type: 'assistant.delta' | 'tool.started' | 'tool.result' | 'status' | 'error' | 'usage' | 'output.truncated';
  payload: Record<string, unknown>;
}
export interface EngineState extends EngineScope {
  status: 'idle' | 'running' | 'cancelling' | 'closed'; sessionFile: string;
  streaming: boolean; pendingMessages: number;
}
export interface CancellationEvidence { requested: boolean; acknowledged: boolean; idle: boolean; forced: boolean; exited: boolean }
export interface EngineResult {
  runId: string; status: 'succeeded' | 'handled' | 'failed' | 'cancelled' | 'interrupted';
  error?: EngineErrorCode; exitCode?: number | null; signal?: string | null;
  toolErrors: number; usage: { inputTokens: number; outputTokens: number };
  cancellation: CancellationEvidence;
}
/** Host owns these trusted build artifacts; callers cannot supply paths over renderer IPC. */
export interface EngineRuntime {
  versions: typeof ENGINE_VERSION;
  node: string; cli: string; extension: string; nativeHost: string;
  hashes: { node: string; cli: string; extension: string; nativeHost: string };
}
