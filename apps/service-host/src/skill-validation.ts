import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { SkillReport } from '@aiappnest/contracts';

export const skillLimits = { files: 1000, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, depth: 20 };
export class SkillValidationError extends Error {
  constructor(readonly path: string, readonly code: string, message: string, readonly line = 0) { super(message); }
}
const fail = (path: string, code: string, message: string): never => { throw new SkillValidationError(path, code, message); };
export function assertUnlinked(path: string): void {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) fail('.', 'LINK_REJECTED', '不允许 symlink 或 junction，包括目录祖先。');
  }
}
export type PackageFiles = Map<string, Buffer>;
/** Bounded reads; all links are rejected, including internal links. Recheck each opened file and parent. */
export function readPackage(root: string): PackageFiles {
  assertUnlinked(root);
  if (!lstatSync(root).isDirectory()) fail('.', 'DIRECTORY_REQUIRED', '请选择本地 Skill 文件夹。');
  const canonical = realpathSync(root), files: PackageFiles = new Map(), names = new Set<string>();
  let total = 0, entries = 0;
  const walk = (directory: string, depth: number) => {
    if (depth > skillLimits.depth) fail('.', 'LIMIT', '目录层级超过 20。');
    assertUnlinked(directory);
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (++entries > 2000) fail('.', 'LIMIT', '目录项过多。');
      const path = join(directory, item.name), rel = relative(root, path).split(sep).join('/').normalize('NFC');
      if (rel.length > 512 || /[<>:"|?*\x00-\x1f\\]/.test(item.name) || /[. ]$/.test(item.name)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(item.name)) fail(rel, 'PATH_REJECTED', '文件名不能安全物化到 Windows。');
      const key = rel.toLowerCase();
      if (names.has(key)) fail(rel, 'PATH_COLLISION', '规范化后路径重复。');
      names.add(key); assertUnlinked(path);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { walk(path, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1) fail(rel, 'LINK_REJECTED', '只接受普通文件，拒绝链接和特殊文件。');
      if (files.size >= skillLimits.files || stat.size > skillLimits.fileBytes || total + stat.size > skillLimits.totalBytes) fail(rel, 'LIMIT', '超过文件数、单文件 8 MiB 或总大小 32 MiB 限制。');
      const fd = openSync(path, 'r');
      try {
        const before = fstatSync(fd);
        if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) fail(rel, 'SOURCE_CHANGED', '源文件在读取时变化，请重试。');
        const bytes = Buffer.alloc(stat.size);
        // readFileSync(fd) can allocate unbounded memory if a file grows; use bounded positional reads instead.
        let offset = 0;
        while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
        const after = fstatSync(fd); assertUnlinked(path);
        if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || realpathSync(path) !== join(canonical, relative(root, path))) fail(rel, 'SOURCE_CHANGED', '源文件在读取时变化，请重试。');
        total += bytes.length; files.set(rel, bytes);
      } finally { closeSync(fd); }
    }
  };
  walk(root, 0); return files;
}
export function packageHash(files: PackageFiles): string {
  const hash = createHash('sha256').update('AIAppNest.Skill.v1\0');
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path)!;
    hash.update(`${Buffer.byteLength(path)}:`).update(path).update(`:${bytes.length}:`).update(bytes);
  }
  return hash.digest('hex');
}
const declaration = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(value => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)), description: z.string().trim().min(1).max(1024),
  'disable-model-invocation': z.boolean().optional(), 'allowed-tools': z.union([z.string().max(10000), z.array(z.string().max(100)).max(100)]).optional(),
  license: z.string().optional(), compatibility: z.string().optional(),
  metadata: z.object({ aiappnest: z.strictObject({
    skillId: z.uuid().regex(/^[0-9a-f-]+$/).optional(), version: z.string().regex(/^\d+\.\d+\.\d+$/).max(40).optional(),
    dependencies: z.array(z.strictObject({ name: z.string().min(1).max(100), constraint: z.string().max(100).default('*') })).max(100).default([]),
    capabilities: z.array(z.string().max(100)).max(100).default([]), references: z.array(z.string().max(512)).max(1000).default([]),
  }).optional() }).passthrough().optional(),
}).passthrough();
export type SkillDeclaration = z.infer<typeof declaration>;
export type DependencyProbe = (name: string, constraint: string) => SkillReport['dependencies'][number];
/** Detection does not search PATH (which may contain the selected package) or execute any imported file. */
export const detectDependency: DependencyProbe = (name, constraint) => {
  if (name === 'node') return { name, constraint, status: constraint === '*' || constraint === process.versions.node ? 'satisfied' : 'unverified', detail: `受管理 Node ${process.versions.node}；其他版本约束未验证。` };
  const programFiles = join(process.env.SystemDrive ?? 'C:', 'Program Files');
  const candidates = name === 'bash' ? [join(programFiles, 'Git', 'bin', 'bash.exe')]
    : name === 'python' ? ['313', '314', '312', '311'].flatMap(v => [join(programFiles, `Python${v}`, 'python.exe'), ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Programs', 'Python', `Python${v}`, 'python.exe')] : [])]) : [];
  if (process.platform === 'win32' && candidates.length) {
    const found = candidates.some(path => existsSync(path));
    return { name, constraint, status: found ? 'unverified' : 'missing', detail: found ? '标准安装位置存在候选；未执行，版本和可运行性未验证。' : `标准安装位置未检测到 ${name}。Windows 不自带通用 Bash；安装属于独立流程。` };
  }
  return { name, constraint, status: 'unverified', detail: '没有受控检测器；声明不是已安装证明，未执行任何命令。' };
};
export const emptyReport = (): SkillReport => ({ valid: false, sha256: null, files: [], scripts: [], diagnostics: [], dependencies: [], capabilities: [], allowedTools: [] });
export function validatePackage(files: PackageFiles, probe: DependencyProbe = detectDependency): { report: SkillReport; metadata?: SkillDeclaration } {
  const report = emptyReport(); report.sha256 = packageHash(files);
  let hasErrors = false;
  report.files = [...files].map(([path, bytes]) => ({ path, bytes: bytes.length })).sort((a,b) => a.path < b.path ? -1 : 1);
  report.scripts = report.files.filter(f => /\.(py|js|mjs|cjs|ts|sh|bash|ps1|bat|cmd|exe|dll)$/i.test(f.path)).map(f => f.path);
  const diagnostic = (path: string, line: number, code: string, message: string, status: 'error' | 'unverified' = 'error') => {
    if (status === 'error') hasErrors = true;
    if (report.diagnostics.length < 1999) report.diagnostics.push({ path, line, code, message, status });
    else if (status === 'error') report.diagnostics[1998] = { path,line,code,message,status };
  };
  const texts = new Map<string,string>();
  for (const [path, bytes] of files) if (/\.(md|txt|py|js|mjs|cjs|ts|sh|bash|ps1|bat|cmd|json|ya?ml)$/i.test(path)) {
    try { texts.set(path, new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { diagnostic(path, 0, 'ENCODING', '文本文件必须使用有效 UTF-8 编码。'); }
  }
  const entry = texts.get('SKILL.md'); let metadata: SkillDeclaration | undefined;
  if (!files.has('SKILL.md')) diagnostic('SKILL.md', 0, 'ENTRY_MISSING', '根目录缺少 SKILL.md。');
  if (entry !== undefined) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entry);
    if (!match) diagnostic('SKILL.md', 1, 'FRONTMATTER', '需要 --- 分隔的 YAML 元信息。');
    else {
      try {
        const doc = parseDocument(match[1]!, { uniqueKeys: true });
        if (doc.errors.length) { for (const error of doc.errors) diagnostic('SKILL.md', (error.linePos?.[0]?.line ?? 1) + 1, 'YAML', 'YAML 格式错误或字段重复。'); }
        else {
          const parsed = declaration.safeParse(doc.toJS({ maxAliasCount: 0 }));
          if (!parsed.success) for (const error of parsed.error.issues) {
            const field = String(error.path.at(-1)); const line = entry.split(/\r?\n/).findIndex(s => s.trimStart().startsWith(`${field}:`)) + 1;
            diagnostic('SKILL.md', Math.max(1,line), 'METADATA', `${error.path.join('.')}: 字段缺失、类型或格式无效。`);
          } else metadata = parsed.data;
        }
      } catch { diagnostic('SKILL.md', 1, 'YAML', '不支持 YAML 别名或复杂对象。'); }
    }
  }
  const reference = (path: string, raw: string, line: number) => {
    let value: string;
    try { value = decodeURIComponent(raw.trim().replace(/^<|>$/g, '')); } catch { diagnostic(path,line,'REFERENCE','引用编码无效。'); return; }
    if (/^https?:\/\//i.test(value) || value.startsWith('#')) { if (!value.startsWith('#')) diagnostic(path,line,'REMOTE_REFERENCE','外部 URL 内容未验证。','unverified'); return; }
    value = value.replace(/\\/g, '/');
    if (/^(?:[a-zA-Z]:|\/|~|file:)/i.test(value) || value.split('/').includes('..')) { diagnostic(path,line,'PATH_ESCAPE','拒绝绝对路径或 .. 路径穿越引用。'); return; }
    if (/[$%{}*?]|^[a-z][a-z0-9+.-]*:/i.test(value)) { diagnostic(path,line,'DYNAMIC_REFERENCE','动态引用无法静态确认。','unverified'); return; }
    const target = relative('.', join(dirname(path), value.split('#')[0]!)).split(sep).join('/').normalize('NFC');
    if (!files.has(target) && ![...files.keys()].some(key => key.startsWith(`${target}/`))) diagnostic(path,line,'REFERENCE_MISSING', `包内引用不存在：${value.slice(0,180)}`);
  };
  for (const [path, text] of texts) {
    if (/\.(md|py|js|mjs|cjs|ts|sh|bash|ps1|bat|cmd)$/i.test(path)) text.split(/\r?\n/).forEach((line,index) => {
      // Conservative lexical rejection, including paths inside shell command snippets and script literals.
      for (const match of line.matchAll(/(?:^|[\s'"`=(])((?:[a-zA-Z]:[/\\]|file:|~[/\\]|\.\.[/\\]|\\\\|\/(?!\/))[^\s'"`<>)]*)/g))
        diagnostic(path,index+1,'PATH_ESCAPE',`拒绝绝对路径或穿越引用：${match[1]!.slice(0,180)}`);
      if (/\$\{|\$\(|%[A-Za-z_][A-Za-z0-9_]*%/.test(line)) diagnostic(path,index+1,'DYNAMIC_REFERENCE','动态引用无法静态确认。','unverified');
    });
    if (path.endsWith('.md')) text.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) reference(path, match[1]!, index + 1);
      for (const match of line.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)) reference(path, match[1]!, index + 1);
      for (const match of line.matchAll(/`([^`\r\n]+)`/g)) if (/[/\\]|\.(?:py|sh|ps1|md|js|json)$|[$%{}]/.test(match[1]!)) {
        if (/\s/.test(match[1]!)) diagnostic(path,index+1,'DYNAMIC_REFERENCE','命令片段无法完整静态验证。','unverified');
        else reference(path,match[1]!,index+1);
      }
    });
    // Scripts are inventory only, never interpreted as an installer or extension.
    if (report.scripts.includes(path)) diagnostic(path,0,'SCRIPT_UNVERIFIED','脚本中的动态文件访问与运行行为未验证；导入不会执行脚本。','unverified');
  }
  if (metadata) {
    const platform = metadata.metadata?.aiappnest;
    for (const ref of platform?.references ?? []) reference('SKILL.md',ref,1);
    report.capabilities = platform?.capabilities ?? [];
    report.allowedTools = typeof metadata['allowed-tools'] === 'string' ? metadata['allowed-tools'].split(/[ ,]+/).filter(Boolean) : metadata['allowed-tools'] ?? [];
    if (report.allowedTools.length > 100 || report.allowedTools.some(s => s.length > 100)) diagnostic('SKILL.md',1,'METADATA','allowed-tools 过长。');
    report.allowedTools = report.allowedTools.slice(0,100).map(s => s.slice(0,100));
    const dependencies = [...(platform?.dependencies ?? [])];
    for (const [ext, name] of [[/\.py$/i,'python'],[/\.(sh|bash)$/i,'bash'],[/\.(js|mjs|cjs)$/i,'node']] as const)
      if (report.scripts.some(path => ext.test(path)) && !dependencies.some(d => d.name === name)) dependencies.push({ name, constraint: '*' });
    if (dependencies.length > 100) diagnostic('SKILL.md',1,'METADATA','声明和脚本推导的依赖总数超过 100。');
    report.dependencies = dependencies.slice(0,100).map(d => probe(d.name,d.constraint));
  }
  report.valid = !!metadata && !hasErrors;
  return { report, metadata };
}
