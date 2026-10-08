import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { DomainError, id, timestamp, type Attachment, type Artifact } from '@aiappnest/domain';
import type { Storage } from '@aiappnest/storage';
import { fileHostRequestSchema, publicError, type FileHostReply, type FileRequest, type FileView, type Result } from '@aiappnest/contracts';
import { canonicalDirectory, checkedTarget } from '../../../packages/policy/src/paths';

type Scope = { appId: string; conversationId: string };
type RecordFile = Attachment | Artifact;
type Selection = Scope & { owner: string; path: string; displayName: string; expiresAt: number; fingerprint: string; cancelled: boolean; importing: boolean };
export const fileLimits = Object.freeze({ attachment: 256 * 1024, artifact: 16 * 1024 * 1024, session: 64 * 1024 * 1024,
  total: 512 * 1024 * 1024, count: 1000, textPreview: 256 * 1024, imagePreview: 2 * 1024 * 1024, tokenMs: 300000 });
const textTypes: Record<string,string> = { '.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.json':'application/json','.log':'text/plain','.yaml':'text/plain','.yml':'text/plain' };
const mime = (name: string) => textTypes[extname(name).toLowerCase()] ?? ({ '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg' }[extname(name).toLowerCase()] ?? 'application/octet-stream');
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const fingerprint = (s: ReturnType<typeof fstatSync>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export class FileError extends Error { constructor(readonly code: 'FILE_QUOTA' | 'FILE_CHANGED' | 'FILE_TYPE' | 'FILE_CANCELLED' | 'FILE_IO' | 'FORBIDDEN' | 'NOT_FOUND') { super(code); } }
function fail(code: FileError['code']): never { throw new FileError(code); }
const decode = (data: Buffer) => { try { const text = new TextDecoder('utf-8',{ fatal:true }).decode(data); if (text.includes('\0')) fail('FILE_TYPE'); return text; } catch { return fail('FILE_TYPE'); } };

/** Service-host owned. IDs cross IPC; source paths and OS-open paths stay behind Main. */
export class FileService {
  private selections = new Map<string,Selection>();
  private closed = false;
  private reserved = new Map<string,Scope & { size: number }>();
  constructor(private readonly storage: Storage, private readonly options: {
    now?: () => number; limits?: Partial<typeof fileLimits>;
    /** Fault injection at actual copy/commit boundaries, never renderer controlled. */
    checkpoint?: (phase: 'copied' | 'publish' | 'commit') => void;
  } = {}) {}
  private get limits() { return { ...fileLimits,...this.options.limits }; }
  private now() { return (this.options.now ?? Date.now)(); }
  private scope(scope: Scope, archived = false) {
    if (this.closed) fail('FILE_CANCELLED');
    const conversation = this.storage.conversations.get({ appId:id<'app'>(scope.appId),id:id<'conversation'>(scope.conversationId) });
    if (!archived && (conversation.status !== 'active' || this.storage.apps.get({ id:conversation.appId }).status === 'archived')) fail('FORBIDDEN');
  }
  private quota(scope: Scope, size: number) {
    const usage = this.storage.fileUsage(scope.appId,scope.conversationId), pending = [...this.reserved.values()];
    if (usage.total + pending.reduce((n,r) => n + r.size,0) + size > this.limits.total
      || usage.session + pending.filter(r => r.appId === scope.appId && r.conversationId === scope.conversationId).reduce((n,r) => n + r.size,0) + size > this.limits.session
      || usage.count + pending.filter(r => r.appId === scope.appId && r.conversationId === scope.conversationId).length >= this.limits.count) fail('FILE_QUOTA');
  }
  private source(path: string, max: number) {
    const root = canonicalDirectory(dirname(path));
    const target = checkedTarget(root,basename(path),false).path;
    const fd = openSync(target,'r');
    try {
      const stat = fstatSync(fd), actual = lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1 || fingerprint(stat) !== fingerprint(actual)) fail('FORBIDDEN');
      if (stat.size > max) fail('FILE_QUOTA');
      return { fd, stat, path:target, root };
    } catch (error) { closeSync(fd); throw error; }
  }
  private bytes(path: string, max: number) {
    const source = this.source(path,max);
    try {
      const data = Buffer.alloc(source.stat.size); let offset = 0;
      while (offset < data.length) { const n = readSync(source.fd,data,offset,data.length-offset,offset); if (!n) fail('FILE_CHANGED'); offset += n; }
      this.unchanged(source); return data;
    } finally { closeSync(source.fd); }
  }
  private unchanged(source: ReturnType<FileService['source']>) {
    const current = checkedTarget(source.root,basename(source.path),false).path;
    if (fingerprint(fstatSync(source.fd)) !== fingerprint(source.stat) || fingerprint(lstatSync(current)) !== fingerprint(source.stat)) fail('FILE_CHANGED');
  }
  private path(file: RecordFile) {
    const area = 'runId' in file ? 'artifacts' : 'attachments';
    const expected = join(this.storage.paths.conversation(file.appId,file.conversationId,area),file.id);
    if (relative(this.storage.paths.root,expected).split(sep).join('/') !== file.relativePath) fail('FORBIDDEN');
    this.storage.paths.assertManaged(expected); return expected;
  }
  private verify(file: RecordFile) {
    const data = this.bytes(this.path(file),this.limits.artifact);
    if (data.length !== file.size || sha(data) !== file.hash) fail('FILE_CHANGED');
    return data;
  }
  private view(file: RecordFile): FileView {
    let status: FileView['status'] = 'ready';
    try {
      const data = this.verify(file);
      if (file.displayName) {
        if (file.mimeType !== mime(file.displayName)) fail('FILE_TYPE');
        if (textTypes[extname(file.displayName).toLowerCase()]) decode(data);
        if (file.mimeType.startsWith('image/') && !validImage(data,file.mimeType)) fail('FILE_TYPE');
      }
    } catch (error) {
      status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : error instanceof FileError && error.code === 'FILE_CHANGED' ? 'changed'
        : error instanceof FileError && error.code === 'FILE_TYPE' ? 'type-mismatch' : 'forbidden';
    }
    return { id:file.id,appId:file.appId,conversationId:file.conversationId,runId:'runId' in file ? file.runId : null,
      kind:'runId' in file ? 'artifact' : 'attachment',displayName:file.displayName || file.id,mimeType:file.mimeType,size:file.size,
      hash:status === 'ready' ? file.hash : null,createdAt:file.createdAt,status,
      externalOpen:status === 'ready' && ['text/plain','text/csv','image/png','image/jpeg'].includes(file.mimeType) };
  }
  async request(raw: unknown): Promise<Result<FileHostReply>> {
    const parsed = fileHostRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok:false,error:publicError('INVALID_INPUT') };
    try {
      const input = parsed.data;
      if (input.operation === 'request') return { ok:true,value:await this.dispatch(input.owner,input.request) };
      this.scope(input);
      for (const [key,selection] of this.selections) if (!selection.importing && selection.expiresAt <= this.now()) this.selections.delete(key);
      if (this.selections.size >= 64) fail('FILE_QUOTA');
      const displayName = basename(input.path);
      if (!textTypes[extname(displayName).toLowerCase()] || displayName.length > 255) fail('FILE_TYPE');
      const source = this.source(input.path,this.limits.attachment); closeSync(source.fd);
      const token = randomUUID(), expiresAt = this.now() + this.limits.tokenMs;
      this.selections.set(token,{ ...input,path:source.path,displayName,expiresAt,fingerprint:fingerprint(source.stat),cancelled:false,importing:false });
      return { ok:true,value:{ operation:'select',selection:{ token,displayName,expiresAt } } };
    } catch (error) {
      return { ok:false,error:publicError(error instanceof FileError ? error.code : error instanceof DomainError && error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FILE_IO') };
    }
  }
  private selection(owner: string, input: Scope & { token: string }) {
    const selection = this.selections.get(input.token);
    if (!selection || selection.owner !== owner || selection.appId !== input.appId || selection.conversationId !== input.conversationId || selection.expiresAt <= this.now()) fail('FORBIDDEN');
    return selection;
  }
  private async dispatch(owner: string,input: FileRequest): Promise<FileHostReply> {
    this.scope(input,input.operation.startsWith('artifacts.'));
    if (input.operation === 'attachments.cancel') {
      const selection = this.selection(owner,input); selection.cancelled = true;
      if (!selection.importing) this.selections.delete(input.token);
      return { operation:'request',reply:{ operation:input.operation } };
    }
    if (input.operation === 'attachments.import') {
      const selection = this.selection(owner,input);
      if (selection.importing || selection.cancelled) fail('FORBIDDEN');
      selection.importing = true;
      try { return { operation:'request',reply:{ operation:input.operation,file:this.view(await this.importFile(selection,input.token)) } }; }
      finally { this.selections.delete(input.token); }
    }
    if (input.operation === 'artifacts.list') {
      if (input.runId && this.storage.runs.get({ appId:id<'app'>(input.appId),id:id<'run'>(input.runId) }).conversationId !== input.conversationId) fail('NOT_FOUND');
      // Bounded enumeration; session file count itself is quota limited.
      const all: Artifact[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = this.storage.artifacts.list({ appId:id<'app'>(input.appId),conversationId:id<'conversation'>(input.conversationId) },{ limit:100,offset });
        all.push(...page.filter(f => !input.runId || f.runId === input.runId)); if (page.length < 100) break;
      }
      return { operation:'request',reply:{ operation:input.operation,files:all.slice(input.offset,input.offset+20).map(f => this.view(f)),hasMore:all.length > input.offset+20 } };
    }
    const file = this.storage.artifacts.get({ appId:id<'app'>(input.appId),id:id<'artifact'>(input.artifactId) });
    if (file.conversationId !== input.conversationId) fail('NOT_FOUND');
    const view = this.view(file);
    if (input.operation === 'artifacts.preview') {
      let preview: Extract<import('@aiappnest/contracts').FileReply,{ operation:'artifacts.preview' }>['preview'] = { kind:'unavailable',reason:view.status === 'ready' ? '此类型不支持内嵌预览' : view.status };
      if (view.status === 'ready') {
        if (textTypes[extname(view.displayName).toLowerCase()] && file.mimeType === mime(view.displayName) && file.size <= this.limits.textPreview) {
          try { preview = { kind:'text',text:decode(this.verify(file)) }; } catch { view.status = 'type-mismatch'; view.externalOpen = false; }
        } else if (['image/png','image/jpeg'].includes(file.mimeType) && file.size <= this.limits.imagePreview) {
          const data = this.verify(file);
          if (file.mimeType === mime(view.displayName) && validImage(data,file.mimeType)) preview = { kind:'image',data:data.toString('base64'),mimeType:file.mimeType as 'image/png' | 'image/jpeg' };
          else { view.status = 'type-mismatch'; view.externalOpen = false; }
        } else if (file.size > this.limits.textPreview) preview = { kind:'unavailable',reason:'文件超过预览大小限制' };
      }
      return { operation:'request',reply:{ operation:input.operation,file:view,preview } };
    }
    if (view.status !== 'ready') fail(view.status === 'missing' ? 'NOT_FOUND' : 'FILE_CHANGED');
    if (input.mode === 'external') {
      if (!view.externalOpen) fail('FILE_TYPE');
      const data = this.verify(file);
      if (file.mimeType.startsWith('image/') ? !validImage(data,file.mimeType) : !textTypes[extname(view.displayName).toLowerCase()]) fail('FILE_TYPE');
      if (!file.mimeType.startsWith('image/')) decode(data);
      // UUID storage has no association. Open a verified, disposable copy with a fixed safe extension.
      const extension = file.mimeType === 'image/png' ? '.png' : file.mimeType === 'image/jpeg' ? '.jpg' : '.txt';
      const folder = join(this.storage.paths.root,'cache','file-open'); this.storage.paths.ensureDirectory(folder);
      const target = join(folder,`${file.id}-${file.hash}${extension}`);
      try { if (sha(this.bytes(target,this.limits.artifact)) !== file.hash) fail('FILE_CHANGED'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { this.writeNew(target,data); } catch (failure) { this.cleanup(target); throw failure; }
      }
      return { operation:'request',reply:{ operation:input.operation,opened:true },openPath:target };
    }
    this.verify(file);
    return { operation:'request',reply:{ operation:input.operation,opened:true },openPath:realpathSync(this.path(file)) };
  }
  private writeNew(path: string,data: Buffer) {
    this.storage.paths.assertManaged(path); const fd = openSync(path,'wx');
    try { let offset = 0; while (offset < data.length) { const n = writeSync(fd,data,offset,data.length-offset); if (!n) fail('FILE_IO'); offset += n; } fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  private cleanup(path: string) { this.storage.paths.assertManaged(path); try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  private async importFile(selection: Selection,token: string): Promise<Attachment> {
    const source = this.source(selection.path,this.limits.attachment), attachmentId = id<'attachment'>(randomUUID());
    const folder = this.storage.paths.conversation(id<'app'>(selection.appId),id<'conversation'>(selection.conversationId),'attachments');
    const target = join(folder,attachmentId), staging = `${target}.partial`;
    let published = false;
    try {
      if (fingerprint(source.stat) !== selection.fingerprint) fail('FILE_CHANGED');
      this.quota(selection,source.stat.size); this.reserved.set(token,{ ...selection,size:source.stat.size });
      this.storage.paths.ensureDirectory(folder);
      const chunks: Buffer[] = []; let offset = 0;
      while (offset < source.stat.size) {
        if (selection.cancelled) fail('FILE_CANCELLED');
        const chunk = Buffer.alloc(Math.min(64 * 1024,source.stat.size-offset));
        const n = readSync(source.fd,chunk,0,chunk.length,offset); if (!n) fail('FILE_CHANGED');
        chunks.push(chunk.subarray(0,n)); offset += n; await yieldIO();
      }
      const data = Buffer.concat(chunks); decode(data);
      this.writeNew(staging,data); this.options.checkpoint?.('copied'); await yieldIO();
      this.unchanged(source); if (selection.cancelled) fail('FILE_CANCELLED'); this.scope(selection);
      const file: Attachment = { id:attachmentId,appId:id<'app'>(selection.appId),conversationId:id<'conversation'>(selection.conversationId),
        relativePath:relative(this.storage.paths.root,target).split(sep).join('/'),displayName:selection.displayName,mimeType:mime(selection.displayName),size:data.length,hash:sha(data),createdAt:timestamp() };
      this.options.checkpoint?.('publish'); this.storage.paths.assertManaged(target); renameSync(staging,target); published = true;
      this.storage.transaction(() => { this.options.checkpoint?.('commit'); this.storage.attachments.insert(file); }); return file;
    } catch (error) { if (published) this.cleanup(target); this.cleanup(staging); throw error; }
    finally { closeSync(source.fd); this.reserved.delete(token); }
  }
  /** Snapshot bytes are copied into the queued prompt; UI reference removal cannot alter admitted work. */
  attachmentText(scope: Scope,attachmentIds: string[]) {
    this.scope(scope); if (new Set(attachmentIds).size !== attachmentIds.length) fail('FORBIDDEN');
    return attachmentIds.map(key => {
      const file = this.storage.attachments.get({ appId:id<'app'>(scope.appId),id:id<'attachment'>(key) });
      if (file.conversationId !== scope.conversationId) fail('NOT_FOUND');
      return `\n<attachment id="${key}">\n${decode(this.verify(file))}\n</attachment>`;
    }).join('');
  }
  close() { this.closed = true; for (const selection of this.selections.values()) selection.cancelled = true; }
  /** Future backup/recycle entry point. Includes crash remnants and open copies, never follows links or deletes. */
  inventory() {
    const registered = this.storage.managedFiles(), known = new Set(registered.map(f => f.relativePath));
    const extra: { relativePath:string; kind:'partial' | 'unregistered' | 'open-cache' }[] = [];
    const walk = (folder:string,cache=false) => {
      this.storage.paths.assertManaged(folder);
      let entries;
      try { entries = readdirSync(folder,{ withFileTypes:true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const path = join(folder,entry.name); this.storage.paths.assertManaged(path);
        if (entry.isDirectory()) { walk(path,cache); continue; }
        if (!entry.isFile() || lstatSync(path).nlink !== 1) fail('FORBIDDEN');
        const relativePath = relative(this.storage.paths.root,path).split(sep).join('/');
        if (!known.has(relativePath)) extra.push({ relativePath,kind:cache ? 'open-cache' : entry.name.endsWith('.partial') ? 'partial' : 'unregistered' });
      }
    };
    for (const scope of this.storage.fileContainers()) for (const area of ['attachments','artifacts'] as const) walk(this.storage.paths.conversation(scope.appId,scope.conversationId,area));
    walk(join(this.storage.paths.root,'cache','file-open'),true);
    return { registered,extra };
  }
  /** Only called after an authorized successful write, or for an explicit trusted output declaration.
   * Always copies the result; external originals and mutable working files are never registered in place. */
  registerOutput(scope: Scope & { runId: string },sourcePath: string): Artifact {
    this.scope(scope);
    const run = this.storage.runs.get({ appId:id<'app'>(scope.appId),id:id<'run'>(scope.runId) });
    if (run.conversationId !== scope.conversationId || !['starting','running','waiting_approval'].includes(run.state)) fail('FORBIDDEN');
    const data = this.bytes(sourcePath,this.limits.artifact), sourceKey = sha(realpathSync(sourcePath)), hash = sha(data);
    const old = this.storage.registeredArtifact(run.appId,run.id,sourceKey,hash);
    if (old) { this.verify(old); return old; }
    this.quota(scope,data.length);
    const artifactId = id<'artifact'>(randomUUID()), target = join(this.storage.paths.root,this.storage.paths.artifact(run.appId,run.conversationId,artifactId)), staging = `${target}.partial`;
    const displayName = basename(sourcePath).slice(0,255);
    const file: Artifact = { id:artifactId,appId:run.appId,conversationId:run.conversationId,runId:run.id,displayName,sourceKey,
      relativePath:this.storage.paths.artifact(run.appId,run.conversationId,artifactId),mimeType:mime(displayName),size:data.length,hash,createdAt:timestamp() };
    let published = false;
    try {
      this.storage.paths.ensureDirectory(dirname(target)); this.writeNew(staging,data); this.options.checkpoint?.('copied');
      this.options.checkpoint?.('publish'); this.storage.paths.assertManaged(target); renameSync(staging,target); published = true;
      this.storage.transaction(() => { this.options.checkpoint?.('commit'); this.storage.artifacts.insert(file); this.storage.appendEvent(run.appId,run.id,'artifact.registered',{ artifactId }); });
      return file;
    } catch (error) { if (published) this.cleanup(target); this.cleanup(staging); throw error; }
  }
}

/** Only raster signatures; bound decoded dimensions to avoid image decompression bombs. */
function validImage(data: Buffer,type: string): boolean {
  const pixels = (w: number,h: number) => w > 0 && h > 0 && w * h <= 16000000;
  if (type === 'image/png') return data.length >= 33 && data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))
    && data.toString('ascii',12,16) === 'IHDR' && pixels(data.readUInt32BE(16),data.readUInt32BE(20));
  if (type !== 'image/jpeg' || data.length < 4 || data.readUInt16BE(0) !== 0xffd8) return false;
  for (let offset = 2; offset + 4 <= data.length;) {
    if (data[offset++] !== 0xff) return false;
    const marker = data[offset++]!, size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) return false;
    if ([0xc0,0xc1,0xc2].includes(marker)) return size >= 8 && pixels(data.readUInt16BE(offset+5),data.readUInt16BE(offset+3));
    offset += size;
  }
  return false;
}
