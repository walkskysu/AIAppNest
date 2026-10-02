import { mkdir, writeFile, access, realpath, stat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, relative, isAbsolute, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spikeRoot } from './native.mjs';
export const cli = fileURLToPath(import.meta.resolve('@mariozechner/pi-coding-agent')).replace(/index\.js$/, 'cli.js');
export const policyExtension = join(spikeRoot, 'src/policy.ts');
export const fixtureProvider = join(spikeRoot, 'fixtures/provider.ts');
export function within(root, path) { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); }
export function workerEnv(config, credentials = {}, parent = process.env) {
  const systemRoot = parent.SystemRoot ?? parent.SYSTEMROOT;
  const env = {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: [join(systemRoot, 'System32'), join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(delimiter),
    USERPROFILE: config.home, HOME: config.home, APPDATA: config.home, LOCALAPPDATA: config.home,
    TEMP: config.temp, TMP: config.temp, PI_CODING_AGENT_DIR: config.agent,
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
    SPIKE_WORKSPACE: config.workspace, SPIKE_MODE: config.mode, SPIKE_APP: config.app,
  };
  for (const [key, value] of Object.entries(credentials)) {
    if (!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(key)) throw new Error('Only explicit API key variables are allowed');
    env[key] = value;
  }
  return env;
}
export async function prepare(root, app, mode = 'controlled') {
  if (!['controlled', 'chat'].includes(mode) || !/^[A-Za-z0-9_-]+$/.test(app)) throw new Error('Invalid config');
  const config = { root: resolve(root), app, mode };
  for (const name of ['agent', 'home', 'temp', 'cwd', 'workspace', 'sessions', 'skills']) {
    config[name] = join(config.root, name); await mkdir(config[name], { recursive: true });
  }
  // The host owns this directory. User files are in workspace, never cwd.
  await writeFile(join(config.agent, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, enableSkillCommands: true, packages: [] }));
  config.role = join(config.root, 'role.txt');
  await writeFile(config.role, `You are the isolated test application ${app}. Do not reveal credentials.`);
  config.skill = join(config.skills, 'SKILL.md');
  await writeFile(config.skill, `---\nname: identity\ndescription: Print this application's harmless identity marker.\n---\nReply exactly SKILL_${app}. Do not call tools.\n`);
  await writeFile(join(config.workspace, 'allowed.txt'), `FILE_${app}`);
  return config;
}
export async function validateSession(config, file) {
  if (!isAbsolute(file)) throw new Error('Exact absolute sessionFile required');
  const actual = await realpath(file);
  if (!within(await realpath(config.sessions), actual)) throw new Error('Session outside conversation');
  if (!(await stat(actual)).isFile()) throw new Error('Session is not a file');
  await access(actual, constants.R_OK);
  // Validate header before Pi can silently initialize an invalid/empty session; never edit JSONL.
  const first = (await readFile(actual, 'utf8')).split('\n')[0];
  let header; try { header = JSON.parse(first); } catch { throw new Error('Invalid session header'); }
  if (header.type !== 'session' || !header.id || header.cwd !== config.cwd) throw new Error('Invalid session ownership/header');
  return actual;
}
export async function launchArgs(config, { sessionFile, fixture = false, provider, model } = {}) {
  if (process.version !== 'v24.19.0') throw new Error('Requires locked Node 24.19.0');
  const manifest = JSON.parse(await readFile(join(dirname(cli), '../package.json'), 'utf8'));
  if (manifest.version !== '0.73.1') throw new Error('Requires locked Pi 0.73.1');
  // CLI has no --no-settings. Refuse untrusted project settings, even with discovery disabled.
  try { await access(join(config.cwd, '.pi/settings.json')); throw new Error('Project settings forbidden in managed cwd'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const args = [cli, '--mode', 'rpc', '--offline', '--session-dir', config.sessions,
    '--no-skills', '--skill', config.skill, '--no-extensions', '--extension', policyExtension,
    '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-builtin-tools',
    '--system-prompt', 'You are a managed test assistant.', '--append-system-prompt', config.role];
  if (fixture) args.push('--extension', fixtureProvider, '--provider', 'spike-fixture', '--model', 'fixture');
  else {
    if (!provider || !model) throw new Error('Explicit provider and model required');
    args.push('--provider', provider, '--model', model);
  }
  if (sessionFile) args.push('--session', await validateSession(config, sessionFile));
  return args;
}
