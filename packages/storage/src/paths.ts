import { existsSync, mkdirSync, lstatSync, renameSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DomainError, id, type AppId, type ArtifactId, type ConversationId, type RevisionId, type SkillId } from '@aiappnest/domain';

/** Only trusted process configuration may override the root; never an IPC/user path. */
export function resolveDataRoot(override?: string, localAppData = process.env.LOCALAPPDATA): string {
  const root = override ?? (localAppData ? join(localAppData, 'LocalAIHub') : undefined);
  if (!root || !isAbsolute(root) || /^[/\\]{2}/.test(root)) throw new DomainError('INVALID_INPUT', 'An absolute local data root is required');
  return resolve(root);
}
export class DataPaths {
  readonly root: string;
  constructor(root: string) { this.root = resolveDataRoot(root); }
  get database(): string { return join(this.root, 'data', 'platform.db'); }
  initialize(): void { for (const directory of ['data', 'apps', 'skills', 'cache', 'logs', 'backups']) this.ensureDirectory(join(this.root, directory)); }
  revision(appId: AppId, revisionId: RevisionId): string { return join(this.root, 'apps', id(appId), 'revisions', id(revisionId)); }
  shared(appId: AppId): string { return join(this.root, 'apps', id(appId), 'shared'); }
  conversation(appId: AppId, conversationId: ConversationId, area: 'agent' | 'sessions' | 'workspace' | 'artifacts' | 'attachments'): string {
    if (!['agent', 'sessions', 'workspace', 'artifacts', 'attachments'].includes(area)) throw new DomainError('INVALID_INPUT');
    return join(this.root, 'apps', id(appId), 'conversations', id(conversationId), area);
  }
  artifact(appId: AppId, conversationId: ConversationId, artifactId: ArtifactId): string {
    return relative(this.root, join(this.conversation(appId, conversationId, 'artifacts'), id(artifactId))).split(sep).join('/');
  }
  skill(skillId: SkillId, version: string): string {
    if (!/^\d+\.\d+\.\d+$/.test(version) || version.length > 40) throw new DomainError('INVALID_INPUT');
    return join(this.root, 'skills', id(skillId), version);
  }
  /** Defense against existing junctions/symlinks, not an OS sandbox or a TOCTOU guarantee. */
  assertManaged(path: string): void {
    const absolute = resolve(path);
    const rel = relative(this.root, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new DomainError('INVALID_INPUT', 'Path outside data root');
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep)) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new DomainError('INVALID_INPUT', 'Linked managed path'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  ensureDirectory(path: string): void { this.assertManaged(path); mkdirSync(path, { recursive: true }); this.assertManaged(path); }
  /** Windows scanners can briefly hold newly flushed descendants. Never overwrite or replay a DB operation. */
  publishDirectory(staging: string, destination: string): void {
    for (let attempt = 0; ; attempt++) {
      this.assertManaged(staging); this.assertManaged(destination);
      if (existsSync(destination)) throw new DomainError('VERSION_CONFLICT');
      try { renameSync(staging,destination); return; }
      catch (error) {
        if (process.platform !== 'win32' || attempt >= 4 || !['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25 * 2 ** attempt);
      }
    }
  }
}
