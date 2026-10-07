import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { channels, emptySchema, publicError, skillRequestSchema, type Result, type ServiceStatus } from '@aiappnest/contracts';
import { ServiceManager } from './service-manager';
import { policyScopeSchema, policyRequestSchema, trustedBoundaryNotice } from '@aiappnest/contracts';

declare const __DEV__: boolean;
const origin = 'app://desktop';
const home = `${origin}/index.html`;
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window: BrowserWindow | null = null;
let service: ServiceManager | undefined;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !service) return;
    event.preventDefault();
    quitting = true;
    void service.stop().finally(() => app.quit());
  });
  void app.whenReady().then(async () => {
    const root = app.getAppPath();
    service = new ServiceManager({ nodePath: join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(root, 'service-host.cjs'),
      // An explicitly selected Electron profile also isolates its platform data (tests/portable profiles).
      dataRoot: app.commandLine.hasSwitch('user-data-dir') ? join(app.getPath('userData'), 'platform') : undefined,
    });
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        const url = new URL(details.url);
        allowed = (url.protocol === 'app:' && url.host === 'desktop' && !url.username && !url.password)
          || (__DEV__ && url.protocol === 'devtools:');
      } catch { /* deny */ }
      callback({ cancel: !allowed });
    });
    await protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (url.host !== 'desktop' || request.method !== 'GET' || !(path === '/index.html' || /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.test(path))) return new Response('', { status: 403 });
      try {
        const data = await readFile(join(root, 'renderer', path.slice(1)));
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
        return new Response(data, { headers: { 'Content-Type': mime[extname(path)]!, 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'" } });
      } catch { return new Response('', { status: 404 }); }
    });
    const trusted = (event: IpcMainInvokeEvent) => !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === home;
    const handle = (channel: string, action: (raw: unknown) => unknown) => {
      ipcMain.handle(channel, (event, raw: unknown) => trusted(event) ? action(raw) : { ok: false, error: publicError('FORBIDDEN') });
    };
    handle(channels.status, (raw): Result<ServiceStatus> => emptySchema.safeParse(raw).success ? { ok: true, value: service!.snapshot() } : { ok: false, error: publicError('INVALID_INPUT') });
    handle(channels.retry, (raw) => emptySchema.safeParse(raw).success ? service!.start() : { ok: false, error: publicError('INVALID_INPUT') });
    handle(channels.ping, (raw) => service!.ping(raw));
    handle(channels.providers, (raw) => service!.providers(raw));
    handle(channels.apps, (raw) => service!.apps(raw));
    // Identity belongs to this Main document generation; the renderer cannot supply it.
    let skillOwner = randomUUID(), choosingSkill = false;
    let choosingPolicy = false;
    // Native dialogs are the only source of external paths and explicit trust consent.
    for (const channel of [channels.selectGrant, channels.trust]) ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!trusted(event)) return { ok: false, error: publicError('FORBIDDEN') };
      const parsed = policyScopeSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
      if (choosingPolicy) return { ok: false, error: publicError('BUSY') };
      choosingPolicy = true; const owner = skillOwner;
      try {
        if (channel === channels.trust) {
          const result = await dialog.showMessageBox(window!, { type: 'warning', title: '启用可信自动化', message: trustedBoundaryNotice,
            buttons: ['取消', '我信任此应用，启用'], defaultId: 0, cancelId: 0, noLink: true });
          if (!trusted(event) || owner !== skillOwner) return { ok: false, error: publicError('FORBIDDEN') };
          if (result.response !== 1) return { ok: true, value: false };
          const reply = await service!.policy({ operation: 'trust', ...parsed.data, notice: trustedBoundaryNotice });
          return reply.ok ? { ok: true, value: reply.value.operation === 'trust' } : reply;
        }
        const result = await dialog.showOpenDialog(window!, { title: '选择授权目录', properties: ['openDirectory'] });
        if (!trusted(event) || owner !== skillOwner) return { ok: false, error: publicError('FORBIDDEN') };
        if (result.canceled || !result.filePaths[0]) return { ok: true, value: null };
        const reply = await service!.policy({ operation: 'select', ...parsed.data, owner, path: result.filePaths[0], scope: 'policy-directory' });
        return reply.ok ? reply.value.operation === 'select' ? { ok: true, value: reply.value.selection } : { ok: false, error: publicError('PROTOCOL_ERROR') } : reply;
      } finally { choosingPolicy = false; }
    });
    handle(channels.policy, async raw => {
      const input = policyRequestSchema.safeParse(raw);
      if (!input.success) return { ok: false, error: publicError('INVALID_INPUT') };
      const reply = await service!.policy({ operation: 'request', owner: skillOwner, request: input.data });
      return reply.ok ? reply.value.operation === 'request' ? { ok: true, value: reply.value.reply } : { ok: false, error: publicError('PROTOCOL_ERROR') } : reply;
    });
    ipcMain.handle(channels.selectSkill, async (event, raw: unknown) => {
      if (!trusted(event)) return { ok:false,error:publicError('FORBIDDEN') };
      if (!emptySchema.safeParse(raw).success) return { ok:false,error:publicError('INVALID_INPUT') };
      if (choosingSkill) return { ok:false,error:publicError('BUSY') };
      choosingSkill = true; const owner = skillOwner;
      try {
        const result = await dialog.showOpenDialog(window!, { title:'导入 Skill 文件夹',properties:['openDirectory'] });
        if (!trusted(event) || owner !== skillOwner) return { ok:false,error:publicError('FORBIDDEN') };
        if (result.canceled || !result.filePaths[0]) return { ok:true,value:null };
        const reply = await service!.skills({ operation:'select',path:result.filePaths[0],owner,scope:'skill-import' });
        return reply.ok ? reply.value.operation === 'select' ? { ok:true,value:reply.value.selection } : { ok:false,error:publicError('PROTOCOL_ERROR') } : reply;
      } finally { choosingSkill = false; }
    });
    handle(channels.skills, async raw => {
      const parsed = skillRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok:false,error:publicError('INVALID_INPUT') };
      const reply = await service!.skills({ operation:'request',owner:skillOwner,request:parsed.data });
      return reply.ok ? reply.value.operation === 'request' ? { ok:true,value:reply.value.reply } : { ok:false,error:publicError('PROTOCOL_ERROR') } : reply;
    });
    window = new BrowserWindow({ width: 1000, height: 720, minWidth: 640, minHeight: 480, backgroundColor: '#f5f6fa', show: false,
      webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: __DEV__ },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) skillOwner = randomUUID(); });
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('closed', () => { window = null; });
    service.on('status', (status: ServiceStatus) => { if (window && !window.webContents.isDestroyed()) window.webContents.send(channels.changed, status); });
    void service.start();
    await window.loadURL(home);
    window.show();
  }).catch(() => { console.error('Desktop initialization failed.'); app.quit(); });
}
