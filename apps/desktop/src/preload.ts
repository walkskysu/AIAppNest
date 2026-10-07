import { chatRequestSchema, chatReplySchema } from '@aiappnest/contracts';
import { runRequestSchema, runReplySchema } from '@aiappnest/contracts';
import { contextBridge, ipcRenderer } from 'electron';
import { channels, pingInputSchema, pingOutputSchema, publicError, resultSchema, statusSchema, type DesktopAPI, type ServiceStatus } from '@aiappnest/contracts';
import { providerRequestSchema, providerReplySchema } from '@aiappnest/contracts';
import { appRequestSchema, appReplySchema } from '@aiappnest/contracts';
import { skillRequestSchema, skillReplySchema, skillSelectionSchema } from '@aiappnest/contracts';
import { policyRequestSchema, policyReplySchema, policyScopeSchema, grantSelectionSchema } from '@aiappnest/contracts';
import { z } from 'zod';

const callbacks = new Set<(status: ServiceStatus) => void>();
// One native listener per document, regardless of Vue component subscription count.
const listener = (_event: unknown, raw: unknown) => {
  const result = statusSchema.safeParse(raw);
  if (result.success) for (const callback of callbacks) { try { callback(result.data); } catch { /* isolate UI subscribers */ } }
};
ipcRenderer.on(channels.changed, listener);
window.addEventListener('unload', () => { callbacks.clear(); ipcRenderer.removeListener(channels.changed, listener); });
const api: DesktopAPI = {
  chat: async input => {
    const parsed = chatRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    const reply = resultSchema(chatReplySchema).safeParse(await ipcRenderer.invoke(channels.chat,parsed.data));
    return reply.success ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  openExternal: async url => {
    const reply = resultSchema(z.boolean()).safeParse(await ipcRenderer.invoke(channels.external,url));
    return reply.success ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  selectGrantDirectory: async scope => {
    const input = policyScopeSchema.safeParse(scope);
    if (!input.success) return { ok: false, error: publicError('INVALID_INPUT') };
    const reply = resultSchema(grantSelectionSchema).safeParse(await ipcRenderer.invoke(channels.selectGrant, input.data));
    return reply.success ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  selectTrustedAutomation: async scope => {
    const input = policyScopeSchema.safeParse(scope);
    if (!input.success) return { ok: false, error: publicError('INVALID_INPUT') };
    const reply = resultSchema(z.boolean()).safeParse(await ipcRenderer.invoke(channels.trust, input.data));
    return reply.success ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  policy: async input => {
    const parsed = policyRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    const reply = resultSchema(policyReplySchema).safeParse(await ipcRenderer.invoke(channels.policy, parsed.data));
    return reply.success && (!reply.data.ok || reply.data.value.operation === parsed.data.operation) ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  selectSkillDirectory: async () => {
    const parsed = resultSchema(skillSelectionSchema).safeParse(await ipcRenderer.invoke(channels.selectSkill,{}));
    return parsed.success ? parsed.data : { ok:false,error:publicError('PROTOCOL_ERROR') };
  },
  skills: async input => {
    const parsed = skillRequestSchema.safeParse(input);
    if (!parsed.success) return { ok:false,error:publicError('INVALID_INPUT') };
    const reply = resultSchema(skillReplySchema).safeParse(await ipcRenderer.invoke(channels.skills,parsed.data));
    return reply.success && (!reply.data.ok || reply.data.value.operation === parsed.data.operation) ? reply.data : { ok:false,error:publicError('PROTOCOL_ERROR') };
  },
  runs: async input => {
    const parsed = runRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    const raw = await ipcRenderer.invoke(channels.runs, parsed.data);
    const reply = resultSchema(runReplySchema).safeParse(raw);
    return reply.success ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  apps: async input => {
    const parsed = appRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    const raw = await ipcRenderer.invoke(channels.apps, parsed.data);
    const reply = resultSchema(appReplySchema).safeParse(raw);
    return reply.success ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  providers: async input => {
    const parsed = providerRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    const raw = await ipcRenderer.invoke(channels.providers, parsed.data);
    const reply = resultSchema(providerReplySchema).safeParse(raw);
    return reply.success ? reply.data : { ok: false, error: publicError('PROTOCOL_ERROR') };
  },
  getStatus: async () => resultSchema(statusSchema).parse(await ipcRenderer.invoke(channels.status, {})),
  retryService: async () => resultSchema(statusSchema).parse(await ipcRenderer.invoke(channels.retry, {})),
  ping: async (input) => {
    const parsed = pingInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    return resultSchema(pingOutputSchema).parse(await ipcRenderer.invoke(channels.ping, parsed.data));
  },
  onStatusChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected callback');
    if (callbacks.size >= 64) throw new Error('Too many subscriptions');
    callbacks.add(callback);
    return () => { callbacks.delete(callback); };
  },
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(api));
