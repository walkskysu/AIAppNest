import { policyExtension } from './policy-extension';
import { type Model, type Api } from '@mariozechner/pi-ai';
import { AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession,
  loadSkills, type AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { RunBoundary } from '../../policy/src/index';
import { PolicyDenied } from '../../policy/src/index';

/** Internal host inputs only; callers resolve Skill integrity and run ownership first. */
export interface PolicySessionOptions {
  boundary: RunBoundary; cwd: string; agentDir: string; roleText: string;
  model: Model<Api>; apiKey: string; skillPaths?: string[];
  onEvent?: (event: AgentSessionEvent) => void;
}
export async function createPolicySession(options: PolicySessionOptions) {
  const { boundary } = options;
  boundary.assertActive();
  try {
  const allowed = [...boundary.tools];
  const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [],
    compaction: { enabled: false }, retry: { enabled: false }, enableSkillCommands: true });
  const authStorage = AuthStorage.inMemory(); authStorage.setRuntimeApiKey(options.model.provider, options.apiKey);
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const guard = policyExtension(boundary, options.cwd);
  const skills = loadSkills({ cwd: options.cwd, agentDir: options.agentDir, skillPaths: options.skillPaths ?? [], includeDefaults: false });
  if (skills.diagnostics.length) throw new PolicyDenied('SKILL_LOAD_FAILED');
  const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: options.roleText, appendSystemPrompt: [], extensionFactories: [guard.extension],
    skillsOverride: () => skills, agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => options.roleText, appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  if (loader.getExtensions().errors.length || loader.getExtensions().extensions.length !== 1) {
    boundary.cancel(); throw new PolicyDenied('EXTENSION_INIT_FAILED');
  }
  const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, model: options.model,
    authStorage, modelRegistry, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(options.cwd),
    thinkingLevel: 'off', noTools: 'all', tools: allowed });
  try {
    await session.bindExtensions({ onError: guard.fail });
    if (!guard.ready() || JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...allowed].sort())) throw new PolicyDenied('EXTENSION_INIT_FAILED');
    // Pi 0.73.1 exposes tool provenance. Built-in fallbacks must not survive overrides.
    if (session.getAllTools().some(tool => tool.sourceInfo.source === 'builtin')) throw new PolicyDenied('BUILTIN_BYPASS');
  } catch (error) { boundary.cancel(); session.dispose(); throw error; }
  session.subscribe(event => {
    // Unknown tools are rejected by Pi before extension tool_call; audit those too.
    if (event.type === 'tool_execution_start' && !allowed.includes(event.toolName)) boundary.reject(event.toolName, event.toolCallId);
    try { options.onEvent?.(event); } catch { /* host projection failure cannot grant authority */ }
  });
  // Do not expose raw SDK, reload, registerTool, executeBash or setActiveTools.
  return Object.freeze({
    tools: Object.freeze([...allowed]),
    async prompt(text: string) {
      boundary.assertActive();
      if (!guard.ready()) throw new PolicyDenied('EXTENSION_FAILED');
      await session.prompt(text);
      return structuredClone(session.messages);
    },
    async cancel() { boundary.cancel(); await session.abort(); },
    async close() { boundary.cancel(); await session.abort(); session.dispose(); },
  });
  } catch (error) { boundary.cancel(); throw error; }
}
