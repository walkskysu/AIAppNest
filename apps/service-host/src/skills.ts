import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { DomainError, id, timestamp, type AppConfig } from '@aiappnest/domain';
import { errorCodeSchema, publicError, skillHostRequestSchema, skillHostReplySchema, skillViewSchema,
  type SkillHostReply, type SkillView, type SkillReply, type SkillReport, type SkillSelection, type Result } from '@aiappnest/contracts';
import type { Storage } from '@aiappnest/storage';
import { assertUnlinked, detectDependency, emptyReport, packageHash, readPackage, SkillValidationError, validatePackage,
  type DependencyProbe, type PackageFiles } from './skill-validation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Binding = AppConfig['skills'][number];
type Options = { now?: () => number; probe?: DependencyProbe; fault?: (point: 'copied' | 'renamed' | 'database') => void };
export class SkillRegistry {
  private tokens = new Map<string, { owner: string; path: string; expiresAt: number; scope: 'skill-import' }>();
  private now: () => number;
  private probe: DependencyProbe;
  constructor(private readonly storage: Storage, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now; this.probe = options.probe ?? detectDependency; this.collect();
  }
  private remove(path: string): void {
    this.storage.paths.assertManaged(path); if (!existsSync(path)) return;
    const inspect = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir,item.name); this.storage.paths.assertManaged(child); if (item.isDirectory()) inspect(child);
    } };
    inspect(path); rmSync(path, { recursive: true, force: true });
  }
  /** The DB lock protects imports in other Service instances from startup collection. */
  collect(): void {
    this.storage.transaction(() => {
      const root = join(this.storage.paths.root,'skills'); this.storage.paths.assertManaged(root);
      for (const item of readdirSync(root, { withFileTypes: true })) {
        const directory = join(root,item.name); this.storage.paths.assertManaged(directory);
        if (!item.isDirectory()) continue;
        if (/^\.staging-/.test(item.name) && uuid.test(item.name.slice(9))) { this.remove(directory); continue; }
        if (!uuid.test(item.name)) continue;
        for (const version of readdirSync(directory, { withFileTypes: true })) {
          if (!version.isDirectory() || !/^\d+\.\d+\.\d+$/.test(version.name)) continue;
          try { this.storage.skills.get({ id: id<'skill'>(item.name), version: version.name }); }
          catch (error) { if (error instanceof DomainError && error.code === 'NOT_FOUND') this.remove(join(directory,version.name)); else throw error; }
        }
      }
    });
  }
  private select(path: string, owner: string): SkillSelection {
    if (!isAbsolute(path) || /^[/\\]{2}/.test(path)) throw new DomainError('INVALID_INPUT');
    assertUnlinked(path);
    const source = resolve(path), rel = relative(this.storage.paths.root, source);
    // Managed sources are never re-imported via the user-directory entrance.
    if (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) throw new DomainError('INVALID_INPUT');
    for (const [token, value] of this.tokens) if (value.expiresAt <= this.now() || value.owner === owner) this.tokens.delete(token);
    if (this.tokens.size >= 64) throw new DomainError('FORBIDDEN');
    const token = randomUUID(), expiresAt = this.now() + 5 * 60_000;
    this.tokens.set(token,{ owner, path: source, expiresAt, scope: 'skill-import' });
    return { token, expiresAt, scope: 'skill-import' };
  }
  private take(token: string, owner: string): string {
    const selection = this.tokens.get(token);
    if (!selection || selection.owner !== owner || selection.expiresAt <= this.now() || selection.scope !== 'skill-import') throw new DomainError('FORBIDDEN');
    this.tokens.delete(token); return selection.path;
  }
  private write(directory: string, files: PackageFiles): void {
    this.storage.paths.ensureDirectory(directory);
    for (const [name, bytes] of files) {
      const path = join(directory,name); this.storage.paths.ensureDirectory(dirname(path)); this.storage.paths.assertManaged(path);
      writeFileSync(path,bytes,{ flag:'wx', flush: true });
    }
  }
  private import(source: string): SkillReply {
    const staging = join(this.storage.paths.root,'skills',`.staging-${randomUUID()}`);
    let destination: string | undefined, created = false;
    try {
      return this.storage.transaction(() => {
        let files: PackageFiles;
        try { files = readPackage(source); }
        catch (error) { if (error instanceof SkillValidationError) return this.invalid(error); throw error; }
        this.write(staging, files); this.options.fault?.('copied');
        let report: SkillReport, metadata;
        try {
          // The staging bytes, not the earlier source metadata, are authoritative.
          const copied = readPackage(staging), checked = validatePackage(copied,this.probe);
          report = checked.report; metadata = checked.metadata;
          if (packageHash(files) !== packageHash(copied) || packageHash(readPackage(source)) !== packageHash(copied))
            throw new SkillValidationError('.', 'SOURCE_CHANGED', '导入期间源目录或暂存内容变化，请重新选择后重试。');
        } catch (error) { if (error instanceof SkillValidationError) return this.invalid(error); throw error; }
        if (!report.valid || !metadata) return { operation:'import', skill:null, report, duplicate:false };
        const platform = metadata.metadata?.aiappnest;
        const sourceKey = process.platform === 'win32' ? source.toLowerCase() : source;
        const digest = createHash('sha256').update(`AIAppNest.source\0${sourceKey}`).digest('hex');
        const skillId = id<'skill'>(platform?.skillId ?? `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`);
        // Content-derived platform version: stable for retries; explicitly never represented as upstream version.
        const version = platform?.version ?? `0.0.${BigInt(`0x${report.sha256!.slice(0,24)}`).toString()}`;
        const value: SkillView = { id:skillId, version, sha256:report.sha256!, name:metadata.name, description:metadata.description,
          source, importedAt:this.now(), entryFile:'SKILL.md', versionOrigin:platform?.version ? 'upstream':'platform',
          identityOrigin:platform?.skillId ? 'declared':'source', report };
        try {
          const old = this.get(skillId,version);
          if (old.sha256 !== value.sha256) throw new DomainError('VERSION_CONFLICT');
          this.verify({ id:skillId,version,hash:old.sha256,enabled:true,invocationMode:'automatic' });
          return { operation:'import', skill:old, report, duplicate:true };
        } catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
        destination = this.storage.paths.skill(skillId,version); this.storage.paths.ensureDirectory(dirname(destination));
        if (existsSync(destination)) this.remove(destination); // unregistered residue only, under the writer lock
        this.storage.paths.publishDirectory(staging,destination); created = true; this.options.fault?.('renamed');
        this.storage.saveSkillDetail({ id:skillId,version,hash:value.sha256,sourcePath:relative(this.storage.paths.root,destination).split(sep).join('/'),
          metadata:{ name:value.name,description:value.description }, importedAt:timestamp(value.importedAt) }, JSON.stringify(skillViewSchema.parse(value)));
        this.options.fault?.('database'); this.verify({ id:skillId,version,hash:value.sha256,enabled:true,invocationMode:'automatic' });
        return { operation:'import',skill:value,report,duplicate:false };
      });
    } catch (error) {
      if (created && destination) try { this.remove(destination); } catch { /* startup collection retries */ }
      throw error;
    } finally { try { this.remove(staging); } catch { /* startup collection retries */ } }
  }
  private invalid(error: SkillValidationError): SkillReply {
    const report = emptyReport(); report.diagnostics.push({ path:error.path.slice(0,512),line:error.line,code:error.code,message:error.message,status:'error' });
    return { operation:'import',skill:null,report,duplicate:false };
  }
  get(skillId: string, version: string): SkillView { return skillViewSchema.parse(JSON.parse(this.storage.skillDetail(id<'skill'>(skillId),version))); }
  verify(binding: Binding): { skill: SkillView; files: PackageFiles; report: SkillReport } {
    const skill = this.get(binding.id,binding.version);
    try {
      const files = readPackage(this.storage.paths.skill(id<'skill'>(binding.id),binding.version));
      if (skill.sha256 !== binding.hash || packageHash(files) !== binding.hash) throw new DomainError('SKILL_INTEGRITY');
      const { report } = validatePackage(files,this.probe);
      if (!report.valid) throw new DomainError('SKILL_INTEGRITY');
      return { skill, files, report };
    } catch { throw new DomainError('SKILL_INTEGRITY'); }
  }
  checkBindings(bindings: Binding[]): void {
    const names = new Set<string>();
    for (const binding of bindings) {
      const { skill,report } = this.verify(binding);
      if (binding.enabled) {
        if (names.has(skill.name)) throw new DomainError('INVALID_INPUT', '同一应用不能启用两个相同 Pi 调用名称。');
        names.add(skill.name);
        if (report.dependencies.some(d => d.status === 'missing')) throw new DomainError('INVALID_INPUT', 'Skill 缺少已知依赖。');
      }
    }
  }
  /** Only trusted revision compilation calls this. No renderer-supplied destination. */
  materialize(binding: Binding, revisionDirectory: string): { path: string; hash: string } {
    const { skill, files } = this.verify(binding);
    const text = new TextDecoder('utf-8',{ fatal:true }).decode(files.get('SKILL.md')!);
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)!;
    const doc = parseDocument(match[1]!); doc.set('disable-model-invocation', binding.invocationMode === 'explicit');
    files.set('SKILL.md',Buffer.from(`---\n${doc.toString()}---\n${text.slice(match[0].length)}`));
    const path = `skills/${binding.id}/${binding.version}/${skill.name}`;
    this.write(join(revisionDirectory,path),files);
    if (packageHash(readPackage(join(revisionDirectory,path))) !== packageHash(files)) throw new DomainError('SKILL_INTEGRITY');
    return { path,hash:packageHash(files) };
  }
  request(raw: unknown): Result<SkillHostReply> {
    const parsed = skillHostRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok:false,error:publicError('INVALID_INPUT') };
    try {
      const input = parsed.data;
      if (input.operation === 'select') return { ok:true,value:{ operation:'select',selection:this.select(input.path,input.owner) } };
      const request = input.request; let reply: SkillReply;
      if (request.operation === 'import') reply = this.import(this.take(request.token,input.owner));
      else if (request.operation === 'list') {
        const result = this.storage.listSkillDetails(request.limit,request.offset);
        reply = { operation:'list',skills:result.details.map(detail => skillViewSchema.parse(JSON.parse(detail))),total:result.total };
      } else if (request.operation === 'get') reply = { operation:'get',skill:this.get(request.id,request.version) };
      else if (request.operation === 'validate') {
        const skill = this.get(request.id,request.version);
        reply = { operation:'validate',report:this.verify({ id:skill.id,version:skill.version,hash:skill.sha256,enabled:true,invocationMode:'automatic' }).report };
      } else {
        // Keep collection under the writer lock so re-import cannot race cleanup.
        // Files remain until COMMIT succeeds; collect() deletes only unregistered versions.
        this.storage.deleteSkill(id<'skill'>(request.id),request.version);
        try { this.collect(); } catch { /* unbindable orphan; retry on restart */ }
        reply = { operation:'delete' };
      }
      return { ok:true,value:skillHostReplySchema.parse({ operation:'request',reply }) };
    } catch (error) {
      const code = error instanceof DomainError ? errorCodeSchema.safeParse(error.code) : undefined;
      return { ok:false,error:publicError(code?.success ? code.data : error instanceof SkillValidationError ? 'INVALID_INPUT':'STORAGE_UNAVAILABLE') };
    }
  }
}
