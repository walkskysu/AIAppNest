import { app, BrowserWindow, dialog, shell, ipcMain, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { channels, emptySchema, publicError, skillRequestSchema, type Result, type ServiceStatus } from '@aiappnest/contracts';
import { ServiceManager } from './service-manager';
import { policyScopeSchema, policyRequestSchema, trustedBoundaryNotice } from '@aiappnest/contracts';
import { fileRequestSchema, fileScopeSchema } from '@aiappnest/contracts';
import { dataRequestSchema } from '@aiappnest/contracts';
import { selectedDataRoot, switchDataRoot } from './data-root';

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
    const profile=app.getPath('userData');
    const initialDataRoot=app.commandLine.hasSwitch('user-data-dir')?join(profile,'platform'):join(process.env.LOCALAPPDATA!,'LocalAIHub');
    const currentDataRoot=selectedDataRoot(profile,initialDataRoot);
    if (app.isPackaged && app.commandLine.hasSwitch('rollback-release')) {
      const node = join(root, 'runtime/node.exe'), cli = join(root, 'release-cli.cjs');
      const run = (command: string, snapshot?: string) => promisify(execFile)(node, [cli, command, currentDataRoot, ...(snapshot ? [snapshot] : [])], { windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP, TMP: process.env.TMP } });
      try {
        const plan = JSON.parse((await run('plan')).stdout);
        const confirmation = await dialog.showMessageBox({ type: 'warning', title: '回退到升级前快照',
          message: plan.notice, detail: `数据目录：${plan.affectedRoot}\n快照时间：${new Date(plan.createdAt).toLocaleString()}\n运行时：${plan.release.id}`,
          buttons: ['取消', '恢复快照并启动旧版本'], defaultId: 0, cancelId: 0 });
        if (confirmation.response === 1) {
          const result = JSON.parse((await run('rollback', plan.snapshot)).stdout);
          app.releaseSingleInstanceLock();
          const child = spawn(join(result.directory, '../../AIAppNest.exe'), app.commandLine.hasSwitch('user-data-dir') ? [`--user-data-dir=${profile}`] : [], {
            detached: true, stdio: 'ignore', windowsHide: true,
            env: Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])) });
          child.on('error', () => dialog.showErrorBox('旧版本启动失败', '快照已恢复，请从保留的版本目录启动匹配的旧版本。'));
          child.unref();
        }
      } catch { dialog.showErrorBox('无法回退', '请关闭其他平台实例，并确认旧版本与快照仍存在。数据未合并；保留所有 snapshot 和 stage 目录，按恢复说明处理。'); }
      app.quit(); return;
    }
    service = new ServiceManager({ nodePath: join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), entry: join(root, 'service-host.cjs'),
      // An explicitly selected Electron profile also isolates its platform data (tests/portable profiles).
      dataRoot: currentDataRoot,
      startupMs: app.isPackaged ? 10 * 60 * 1000 : 5000,
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
        return new Response(data, { headers: { 'Content-Type': mime[extname(path)]!, 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'" } });
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
    handle(channels.memories, raw => service!.memories(raw));
    handle(channels.chat, raw => service!.chat(raw));
    handle(channels.external, async raw => {
      if (typeof raw !== 'string' || raw.length > 4096) return { ok: false, error: publicError('INVALID_INPUT') };
      try {
        const url = new URL(raw);
        if (!['https:','http:'].includes(url.protocol) || url.username || url.password) throw new Error();
        await shell.openExternal(url.href);
        return { ok: true, value: true };
      } catch { return { ok: false, error: publicError('INVALID_INPUT') }; }
    });
    handle(channels.runs, async raw => {
      const reply=await service!.runs(raw);
      if (!reply.ok || reply.value.operation!=='diagnostics.export') return reply;
      const result=await dialog.showSaveDialog(window!,{ title:'导出脱敏运行诊断',defaultPath:`run-${reply.value.diagnostic.runId}.json`,filters:[{ name:'JSON',extensions:['json'] }] });
      if (result.canceled || !result.filePath) return { ok:true,value:{ ...reply.value,saved:false } };
      try { await writeFile(result.filePath,JSON.stringify(reply.value.diagnostic,null,2)+'\n',{ mode:0o600 });return { ok:true,value:{ ...reply.value,saved:true } }; }
      catch { return { ok:false,error:publicError('STORAGE_UNAVAILABLE') }; }
    });
    handle(channels.apps, (raw) => service!.apps(raw));
    // Identity belongs to this Main document generation; the renderer cannot supply it.
    let skillOwner = randomUUID(), choosingSkill = false;
    let choosingData=false;
    ipcMain.handle(channels.selectData,async(event,raw:unknown)=>{
      if(!trusted(event))return {ok:false,error:publicError('FORBIDDEN')};
      if(!['backup','package','restore'].includes(String(raw)))return {ok:false,error:publicError('INVALID_INPUT')};
      if(choosingData)return {ok:false,error:publicError('BUSY')};
      choosingData=true;const owner=skillOwner;
      try {
        const result=await dialog.showOpenDialog(window!,{title:raw==='package'?'选择 .aibackup 备份目录':raw==='restore'?'选择新数据目录的父目录':'选择备份目标目录',properties:['openDirectory','createDirectory']});
        if(!trusted(event)||owner!==skillOwner)return {ok:false,error:publicError('FORBIDDEN')};
        if(result.canceled||!result.filePaths[0])return {ok:true,value:{operation:'select'}};
        return service!.data({operation:'select',owner,purpose:raw,path:result.filePaths[0]});
      }finally{choosingData=false;}
    });
    ipcMain.handle(channels.data,async(event,raw:unknown)=>{
      if(!trusted(event))return {ok:false,error:publicError('FORBIDDEN')};
      const parsed=dataRequestSchema.safeParse(raw);if(!parsed.success)return {ok:false,error:publicError('INVALID_INPUT')};
      const reply=await service!.data({operation:'request',owner:skillOwner,request:parsed.data});
      if(reply.ok && reply.value.restartRequired && reply.value.job?.output) {
        await service!.stop();
        try{switchDataRoot(profile,currentDataRoot,reply.value.job.output);app.relaunch();app.quit();}
        catch{console.error('Data root switch failed; restarting from the committed root pointer.');app.relaunch();app.quit();return {ok:false,error:publicError('STORAGE_UNAVAILABLE')};}
      }
      return reply;
    });
    let choosingFile = false;
    ipcMain.handle(channels.selectAttachment,async (event,raw: unknown) => {
      if (!trusted(event)) return { ok:false,error:publicError('FORBIDDEN') };
      const parsed = fileScopeSchema.safeParse(raw);
      if (!parsed.success) return { ok:false,error:publicError('INVALID_INPUT') };
      if (choosingFile) return { ok:false,error:publicError('BUSY') };
      choosingFile = true; const owner = skillOwner;
      try {
        const result = await dialog.showOpenDialog(window!,{ title:'导入文本附件（UTF-8，最大 256 KiB）',properties:['openFile'],filters:[{ name:'文本附件',extensions:['txt','md','csv','json','log','yaml','yml'] }] });
        if (!trusted(event) || owner !== skillOwner) return { ok:false,error:publicError('FORBIDDEN') };
        if (result.canceled || !result.filePaths[0]) return { ok:true,value:null };
        const reply = await service!.files({ operation:'select',...parsed.data,owner,path:result.filePaths[0] });
        return reply.ok ? reply.value.operation === 'select' ? { ok:true,value:reply.value.selection } : { ok:false,error:publicError('PROTOCOL_ERROR') } : reply;
      } finally { choosingFile = false; }
    });
    ipcMain.handle(channels.files,async (event,raw: unknown) => {
      if (!trusted(event)) return { ok:false,error:publicError('FORBIDDEN') };
      const parsed = fileRequestSchema.safeParse(raw);
      if (!parsed.success) return { ok:false,error:publicError('INVALID_INPUT') };
      const owner = skillOwner;
      const reply = await service!.files({ operation:'request',owner,request:parsed.data });
      if (!reply.ok) return reply;
      if (reply.value.operation !== 'request') return { ok:false,error:publicError('PROTOCOL_ERROR') };
      if (parsed.data.operation === 'artifacts.open') {
        if (!trusted(event) || owner !== skillOwner) return { ok:false,error:publicError('FORBIDDEN') };
        const path = reply.value.openPath;
        if (!path) return { ok:false,error:publicError('PROTOCOL_ERROR') };
        if (parsed.data.mode === 'folder') shell.showItemInFolder(path);
        else if (await shell.openPath(path)) return { ok:false,error:publicError('FILE_IO') };
      }
      return { ok:true,value:reply.value.reply };
    });
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
