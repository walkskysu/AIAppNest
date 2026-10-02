import { Type } from '@mariozechner/pi-ai';
import { realpath, readFile, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';

export default function (pi) {
  const root = process.env.SPIKE_WORKSPACE!;
  const chat = process.env.SPIKE_MODE === 'chat';
  const allowed = chat ? [] : ['controlled_read', 'denied_write', 'test_wait'];
  pi.on('session_start', () => { pi.setActiveTools(allowed); });
  pi.on('tool_call', (event) => {
    if (!allowed.includes(event.toolName) || event.toolName === 'denied_write') {
      return { block: true, reason: 'POLICY_DENIED' };
    }
  });
  pi.registerTool({ name: 'denied_write', label: 'Denied write probe', description: 'Permission test: always denied before writing.',
    parameters: Type.Object({}), async execute() {
      await writeFile(join(root, 'MUST_NOT_EXIST'), 'side effect');
      return { content: [{ type: 'text', text: 'BUG: wrote file' }], details: {} };
    }
  });
  pi.registerTool({ name: 'controlled_read', label: 'Controlled read', description: 'Read an existing UTF-8 file inside the authorized workspace.',
    parameters: Type.Object({ path: Type.String() }), async execute(_id, params) {
      // Existing read-only files; not a production TOCTOU-safe authorization service.
      if (params.path.includes(':') || params.path.startsWith('\\\\')) throw new Error('POLICY_PATH_DENIED');
      const canonicalRoot = await realpath(root);
      const target = await realpath(join(root, params.path));
      const rel = relative(canonicalRoot, target);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('POLICY_PATH_DENIED');
      return { content: [{ type: 'text', text: await readFile(target, 'utf8') }], details: {} };
    }
  });
  pi.registerTool({ name: 'test_wait', label: 'Harmless wait', description: 'Test-only long process. Writes its PID, waits; no external side effects.',
    parameters: Type.Object({ stubborn: Type.Boolean() }), async execute(_id, params, signal) {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { shell: false, windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot } });
      await writeFile(join(root, 'wait.pid'), String(child.pid));
      await new Promise<void>((resolve, reject) => {
        const abort = () => { if (!params.stubborn) child.kill(); };
        child.once('error', reject);
        child.once('exit', () => { signal?.removeEventListener('abort', abort); resolve(); });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
      return { content: [{ type: 'text', text: 'wait finished' }], details: {} };
    }
  });
  // Only this trusted extension can handle without starting a run. Publish a diagnostic marker.
  pi.on('input', (event, ctx) => {
    if (event.text === '__handled__') { ctx.ui.notify('SPIKE_HANDLED', 'info'); return { action: 'handled' }; }
  });
  pi.registerCommand('spike-barrier', { handler: async (_args, ctx) => { await ctx.waitForIdle(); } });
  pi.registerCommand('spike-inspect', { handler: async (_args, ctx) => {
    ctx.ui.notify(JSON.stringify({ tools: pi.getActiveTools(), app: process.env.SPIKE_APP,
      ambientKeyPresent: !!process.env.UNRELATED_API_KEY,
      keyPresent: !!process.env.OPENAI_API_KEY,
      keyCount: Object.keys(process.env).filter(key => /^[A-Z][A-Z0-9_]*_API_KEY$/.test(key)).length,
      poisoned: ctx.getSystemPrompt().includes('UNAPPROVED_CANARY'),
      rolePresent: ctx.getSystemPrompt().includes(`application ${process.env.SPIKE_APP}`) }), 'info');
  } });
}
