import { Type } from '@mariozechner/pi-ai';
import { 
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  type ExtensionFactory, type ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { RunBoundary } from '../../policy/src/index';
import { PolicyDenied } from '../../policy/src/index';


export function policyExtension(boundary: RunBoundary, cwd: string) {
  const allowed = [...boundary.tools];
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
        const tool: ToolDefinition<any, any> = factory(cwd);
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
  return { extension, ready: () => initialized && started && !failed, fail: () => { failed = true; boundary.cancel(); } };
}
