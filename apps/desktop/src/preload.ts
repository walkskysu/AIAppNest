import { contextBridge, ipcRenderer } from 'electron';
import { channels, pingInputSchema, pingOutputSchema, publicError, resultSchema, statusSchema, type DesktopAPI, type ServiceStatus } from '@aiappnest/contracts';
import { providerRequestSchema, providerReplySchema } from '@aiappnest/contracts';
import { appRequestSchema, appReplySchema } from '@aiappnest/contracts';

const callbacks = new Set<(status: ServiceStatus) => void>();
// One native listener per document, regardless of Vue component subscription count.
const listener = (_event: unknown, raw: unknown) => {
  const result = statusSchema.safeParse(raw);
  if (result.success) for (const callback of callbacks) { try { callback(result.data); } catch { /* isolate UI subscribers */ } }
};
ipcRenderer.on(channels.changed, listener);
window.addEventListener('unload', () => { callbacks.clear(); ipcRenderer.removeListener(channels.changed, listener); });
const api: DesktopAPI = {
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
