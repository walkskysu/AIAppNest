import { Type, type Model, type Api } from '@mariozechner/pi-ai';
import { AuthStorage, ModelRegistry, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, loadSkills,
  type ExtensionFactory, type ToolDefinition, type AgentSessionEvent } from '@mariozechner/pi-coding-agent';
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
  let initialized = false, started = false, failed = false;
  const extension: ExtensionFactory = pi => {
    boundary.assertActive();
    const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
    const fileParameters = Type.Object({ grantId: Type.String({ format: 'uuid' }), path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
    const writeParameters = Type.Object({ ...fileParameters.properties, content: Type.String({ maxLength: 1048576 }) }, { additionalProperties: false });
    const methods = { platform_read: boundary.read, platform_list: boundary.list, platform_write: boundary.write, platform_output: boundary.output };
    if (boundary.mode === 'controlled-files') {
      for (const [name, execute] of Object.entries(methods)) if (allowed.includes(name)) pi.registerTool({
        name, label: name, description: 'Platform-authorized file operation. A read grant and a write grant are independent.',
        parameters: name === 'platform_read' || name === 'platform_list' ? fileParameters : writeParameters,
        executionMode: 'sequential',
        execute: async (callId, args, signal) => result(await execute(callId, args, signal)),
      });
    } else if (boundary.mode === 'trusted-automation') {
      // Override every allowed built-in with an entry wrapper; no raw built-in may remain.
      const factories = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
        createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition];
      for (const factory of factories) {
        const tool: ToolDefinition<any, any> = factory(options.cwd);
        if (!allowed.includes(tool.name)) continue;
        pi.registerTool({ ...tool, executionMode: 'sequential', execute: async (callId, args, signal, update, ctx) => {
          const fixedArgs = structuredClone(args);
          return boundary.trusted(callId, tool.name, fixedArgs, () => tool.execute(callId, fixedArgs, signal, update, ctx), signal);
        } });
      }
    }
    pi.on('session_start', () => {
      boundary.assertActive();
      pi.setActiveTools(allowed);
      if (JSON.stringify(pi.getActiveTools().sort()) !== JSON.stringify([...allowed].sort())) throw new PolicyDenied('TOOL_SET_MISMATCH');
      started = true;
    });
    pi.on('tool_call', event => {
      if (!initialized || !started || failed || !allowed.includes(event.toolName)) {
        boundary.reject(event.toolName, event.toolCallId);
        return { block: true, reason: JSON.stringify({ code: 'POLICY_DENIED', reason: 'TOOL_DENIED' }) };
      }
      try { boundary.assertActive(); }
      catch { return { block: true, reason: JSON.stringify({ code: 'POLICY_DENIED', reason: 'RUN_INACTIVE' }) }; }
    });
    initialized = true;
  };
  const skills = loadSkills({ cwd: options.cwd, agentDir: options.agentDir, skillPaths: options.skillPaths ?? [], includeDefaults: false });
  if (skills.diagnostics.length) throw new PolicyDenied('SKILL_LOAD_FAILED');
  const loader = new DefaultResourceLoader({ cwd: options.cwd, agentDir: options.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: options.roleText, appendSystemPrompt: [], extensionFactories: [extension],
    skillsOverride: () => skills, agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => options.roleText, appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  if (!initialized || loader.getExtensions().errors.length || loader.getExtensions().extensions.length !== 1) {
    boundary.cancel(); throw new PolicyDenied('EXTENSION_INIT_FAILED');
  }
  const { session } = await createAgentSession({ cwd: options.cwd, agentDir: options.agentDir, model: options.model,
    authStorage, modelRegistry, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(options.cwd),
    thinkingLevel: 'off', noTools: 'all', tools: allowed });
  try {
    await session.bindExtensions({ onError: () => { failed = true; boundary.cancel(); } });
    if (!started || failed || JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...allowed].sort())) throw new PolicyDenied('EXTENSION_INIT_FAILED');
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
      if (failed) throw new PolicyDenied('EXTENSION_FAILED');
      await session.prompt(text);
      return structuredClone(session.messages);
    },
    async cancel() { boundary.cancel(); await session.abort(); },
    async close() { boundary.cancel(); await session.abort(); session.dispose(); },
  });
  } catch (error) { boundary.cancel(); throw error; }
}
