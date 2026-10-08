import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { id } from '@aiappnest/domain';
import type { Storage } from '@aiappnest/storage';
import type { AppService } from '../../../apps/service-host/src/apps';
import type { ProviderService } from '../../../apps/service-host/src/providers';
import type { PolicyService } from '../../policy/src/service';
import { ENGINE_VERSION, EngineError, type EngineRuntime, type EngineScope } from './types';

export interface EngineServices {
  storage: Storage; apps: Pick<AppService, 'readRevision' | 'resolveSkills'>;
  providers: Pick<ProviderService, 'snapshotRuntime'>; policy: Pick<PolicyService, 'bindRun'>;
}
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function readEngineRuntime(directory: string): EngineRuntime {
  const raw = JSON.parse(readFileSync(join(directory, 'engine-runtime.json'), 'utf8')) as EngineRuntime;
  for (const name of ['node', 'cli', 'extension', 'nativeHost'] as const) raw[name] = resolve(directory, raw[name]);
  return raw;
}
export function verifyRuntime(runtime: EngineRuntime): void {
  if (process.versions.node !== ENGINE_VERSION.node || process.platform !== 'win32' || process.arch !== 'x64'
    || JSON.stringify(runtime.versions) !== JSON.stringify(ENGINE_VERSION)) throw new EngineError('VERSION_MISMATCH');
  try {
    for (const name of ['node', 'cli', 'extension', 'nativeHost'] as const) {
      if (!isAbsolute(runtime[name]) || !lstatSync(runtime[name]).isFile()
        || sha256(readFileSync(runtime[name])) !== runtime.hashes[name]) throw new Error();
    }
    const manifest = JSON.parse(readFileSync(join(dirname(runtime.cli), '../package.json'), 'utf8'));
    if (manifest.version !== ENGINE_VERSION.pi || manifest.bin.pi !== 'dist/cli.js') throw new Error();
  } catch { throw new EngineError('VERSION_MISMATCH'); }
}
export interface CompiledSession {
  scope: EngineScope; cwd: string; agent: string; sessions: string; configFile: string; roleFile: string;
  home: string; temp: string; env: NodeJS.ProcessEnv; args: string[]; sessionFile: string | null;
  timeoutMs: number; maxTurns: number; modelId: string; tools: string[]; skillExpansionBytes: number;
}
export function validateSessionPath(services: EngineServices, config: Pick<CompiledSession, 'sessions' | 'cwd'>, file: string, existing: boolean): string {
  try {
    const rel = relative(config.sessions, file);
    if (!isAbsolute(file) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !file.endsWith('.jsonl')) throw new Error();
    services.storage.paths.assertManaged(file);
    if (realpathSync(dirname(file)) !== realpathSync(config.sessions)) throw new Error();
    if (!existing) { if (existsSync(file)) throw new Error(); return file; }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    if (!text.endsWith('\n')) throw new Error();
    const lines = text.trimEnd().split('\n').map(line => JSON.parse(line));
    const header = lines.shift();
    if (header?.type !== 'session' || header.version !== ENGINE_VERSION.session || typeof header.id !== 'string'
      || !header.id || header.cwd !== config.cwd || !Number.isFinite(Date.parse(header.timestamp))) throw new Error();
    const ids = new Set<string>();
    const types = new Set(['message','thinking_level_change','model_change','compaction','branch_summary','custom','custom_message','label','session_info']);
    for (const entry of lines) {
      if (!types.has(entry.type) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || !Number.isFinite(Date.parse(entry.timestamp))
        || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error();
      if (entry.type === 'message') {
        const m = entry.message;
        if (!m || !['user','assistant','toolResult'].includes(m.role) || !Number.isFinite(m.timestamp)) throw new Error();
        if (!(m.role === 'user' && typeof m.content === 'string')) {
          if (!Array.isArray(m.content) || m.content.some((block: any) => !block || !['text','thinking','toolCall','image'].includes(block.type)
            || (block.type === 'text' && typeof block.text !== 'string') || (block.type === 'thinking' && typeof block.thinking !== 'string')
            || (block.type === 'toolCall' && (typeof block.id !== 'string' || typeof block.name !== 'string' || !block.arguments))
            || (block.type === 'image' && (typeof block.data !== 'string' || typeof block.mimeType !== 'string')))) throw new Error();
        }
        if (m.role === 'assistant' && (!['stop','length','toolUse','error','aborted'].includes(m.stopReason) || typeof m.model !== 'string' || !m.usage)) throw new Error();
        if (m.role === 'toolResult' && (typeof m.toolCallId !== 'string' || typeof m.toolName !== 'string' || typeof m.isError !== 'boolean')) throw new Error();
      }
      ids.add(entry.id);
    }
    return realpathSync(file);
  } catch { throw new EngineError('SESSION_INVALID'); }
}
export function compileSession(services: EngineServices, runtime: EngineRuntime, appId: string, conversationId: string, restore: boolean): CompiledSession {
  verifyRuntime(runtime);
  const { storage, apps, providers } = services;
  const app = id<'app'>(appId), conversation = storage.conversations.get({ appId: app, id: id<'conversation'>(conversationId) });
  if (conversation.status !== 'active' || storage.apps.get({ id: app }).status === 'archived') throw new EngineError('INVALID_STATE');
  if (restore !== (conversation.piSessionFile !== null)) throw new EngineError('INVALID_STATE');
  const revision = apps.readRevision(appId, conversation.revisionId), snapshot = revision.snapshot;
  if (revision.appId !== appId || revision.id !== conversation.revisionId || snapshot.runtimeVersion !== ENGINE_VERSION.pi) throw new EngineError('VERSION_MISMATCH');
  const skills = apps.resolveSkills(appId, conversation.revisionId);
  if (skills.discovery !== false || skills.extensions.length) throw new EngineError('RESOURCE_INVALID');
  const provider = providers.snapshotRuntime(snapshot.credentialBinding, snapshot.provider);
  const agent = storage.paths.conversation(app, conversation.id, 'agent'), sessions = storage.paths.conversation(app, conversation.id, 'sessions');
  const cwd = join(agent, 'cwd'), home = join(agent, 'home'), temp = join(agent, 'temp');
  for (const path of [agent, sessions, cwd, home, temp]) storage.paths.ensureDirectory(path);
  if (existsSync(join(cwd, '.pi/settings.json'))) throw new EngineError('RESOURCE_INVALID');
  // CLI still reads these despite discovery flags. Never accept copied ambient models or credentials.
  if (existsSync(join(agent, 'models.json'))) throw new EngineError('RESOURCE_INVALID');
  const authFile = join(agent, 'auth.json');
  storage.paths.assertManaged(authFile);
  if (existsSync(authFile) && (lstatSync(authFile).nlink !== 1 || readFileSync(authFile, 'utf8').trim() !== '{}')) throw new EngineError('RESOURCE_INVALID');
  const configFile = join(agent, 'engine.json'), roleFile = join(agent, 'role.md');
  const permissions = snapshot.config.permissions;
  const tools = permissions.mode === 'chat' ? [] : permissions.mode === 'controlled-files'
    ? [...(permissions.tools.includes('read') ? ['platform_read', 'platform_list'] : []), ...(permissions.tools.includes('write') ? ['platform_write', 'platform_output'] : [])]
    : [...(permissions.tools.includes('read') ? ['read','grep','find','ls'] : []), ...(permissions.tools.includes('write') ? ['write','edit','platform_register_output'] : []), ...(permissions.tools.includes('shell') ? ['bash'] : [])];
  const scope = { appId, conversationId, revisionId: conversation.revisionId };
  const settingsFile = join(agent, 'settings.json');
  for (const file of [configFile, roleFile, settingsFile]) {
    storage.paths.assertManaged(file);
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).nlink !== 1)) throw new EngineError('RESOURCE_INVALID');
  }
  // Neither credentials nor arbitrary provider environment are persisted.
  writeFileSync(configFile, JSON.stringify({ ...scope, versions: ENGINE_VERSION, tools, mode: permissions.mode,
    model: { ...provider.model, maxTokens: snapshot.config.model!.maxOutputTokens }, providerType: provider.providerType,
    authMode: provider.authMode, timeoutMs: provider.timeoutMs, temperature: snapshot.config.model!.temperature }));
  writeFileSync(roleFile, snapshot.roleText);
  writeFileSync(settingsFile, JSON.stringify({ packages: [], extensions: [], skills: [], prompts: [], themes: [],
    retry: { enabled: false }, compaction: { enabled: false }, enableSkillCommands: true }));
  const systemRoot = process.env.SystemRoot;
  const env: NodeJS.ProcessEnv = { SystemRoot: systemRoot, WINDIR: systemRoot, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    TEMP: temp, TMP: temp, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
    AIAPPNEST_ENGINE_CONFIG: configFile, AIAPPNEST_MODEL_API_KEY: provider.apiKey };
  env.PATH = [dirname(runtime.node), join(systemRoot!, 'System32'), join(systemRoot!, 'System32/WindowsPowerShell/v1.0')].join(delimiter);
  if (tools.includes('bash')) {
    const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].find(root => root && existsSync(join(root, 'Git/bin/bash.exe')));
    if (!programFiles) throw new EngineError('RESOURCE_INVALID');
    // The pinned Pi Bash tool searches these explicit OS locations; never inherit arbitrary user PATH.
    env.ProgramFiles = programFiles;
  }
  const args = [runtime.cli, '--mode', 'rpc', '--offline', '--session-dir', sessions, '--no-skills', '--no-extensions',
    '--extension', runtime.extension, '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-tools', '--tools', tools.join(','),
    '--system-prompt', 'You are a managed application assistant.', '--append-system-prompt', roleFile,
    '--provider', 'aiappnest', '--model', provider.model.id, '--thinking', 'off'];
  for (const skill of skills.paths) args.push('--skill', skill);
  const config: CompiledSession = { scope, cwd, agent, sessions, configFile, roleFile, home, temp, env, args,
    sessionFile: conversation.piSessionFile, timeoutMs: snapshot.config.execution.timeoutMs,
    maxTurns: snapshot.config.execution.maxTurns, modelId: provider.model.id, tools,
    skillExpansionBytes: skills.paths.reduce((sum,path) => sum + readFileSync(path).length + Buffer.byteLength(path)*2 + 512,0) };
  if (restore) args.push('--session', validateSessionPath(services, config, conversation.piSessionFile!, true));
  return config;
}
