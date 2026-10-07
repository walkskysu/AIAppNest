import type { Id, MessageStatus, RunState, Timestamp } from './models';
export type DomainErrorCode = 'BUSY' | 'SHUTTING_DOWN' | 'NOT_READY' | 'NOT_FOUND' | 'OWNERSHIP_MISMATCH' | 'VERSION_CONFLICT' | 'DUPLICATE_RECORD' | 'INVALID_TRANSITION' | 'INVALID_INPUT' | 'STORAGE_UNAVAILABLE' | 'SKILL_INTEGRITY' | 'SKILL_IN_USE' | 'FORBIDDEN';
export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string = code, options?: ErrorOptions) { super(message, options); this.name = 'DomainError'; }
}
export function id<K extends string>(value: string): Id<K> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new DomainError('INVALID_INPUT', 'Expected a canonical UUID');
  return value as Id<K>;
}
export function timestamp(value: number = Date.now()): Timestamp {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw new DomainError('INVALID_INPUT', 'Expected UTC epoch milliseconds');
  return value as Timestamp;
}
export function requireSameApp(expected: Id<'app'>, actual: Id<'app'>): void {
  if (expected !== actual) throw new DomainError('OWNERSHIP_MISMATCH');
}
export const runTransitions: Readonly<Record<RunState, readonly RunState[]>> = {
  queued: ['starting', 'cancelled'], starting: ['running', 'failed', 'cancelling', 'interrupted', 'handled'],
  running: ['handled', 'waiting_approval', 'cancelling', 'succeeded', 'failed', 'interrupted'],
  waiting_approval: ['running', 'cancelling', 'failed', 'interrupted'], cancelling: ['cancelled', 'interrupted'],
  succeeded: [], failed: [], cancelled: [], interrupted: [], handled: [],
};
export function assertRunTransition(from: RunState, to: RunState): void {
  if (!runTransitions[from]?.includes(to)) throw new DomainError('INVALID_TRANSITION');
}
export const terminalRunStates: readonly RunState[] = ['succeeded', 'failed', 'cancelled', 'interrupted', 'handled'];
export function assertMessageTransition(from: MessageStatus, to: MessageStatus): void {
  if (from !== 'streaming' || !['streaming', 'complete', 'failed'].includes(to)) throw new DomainError('INVALID_TRANSITION');
}
