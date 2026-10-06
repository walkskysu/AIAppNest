import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, rm, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn) { for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(40); } throw new Error('Condition timed out'); }
function environment() { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; return env; }
async function launch(t, root = resolve('dist')) {
  const profile = await mkdtemp(resolve('.test-profile-'));
  // Register cleanup before launch as native sandbox initialization can fail.
  let app;
  let closed = false;
  t.after(async () => {
    if (app && !closed) await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  app = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${profile}`], env: environment(), timeout: 20000 });
  app.on('close', () => { closed = true; });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.desktop);
  return { app, page, profile };
}
async function ready(page) { await page.waitForFunction(() => document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase') === 'ready'); }

test('A01/A02/A07/A08 desktop app management uses forms, persists after service restart and opens no Worker', { timeout: 60000 }, async t => {
  const { page } = await launch(t); await ready(page);
  const pid = (await page.evaluate(() => window.desktop.getStatus())).value.pid;
  await page.getByRole('button', { name: '创建应用', exact: true }).click();
  await page.getByLabel('应用名称', { exact: true }).fill('桌面写作助手');
  await page.getByLabel('应用简介', { exact: true }).fill('中文描述');
  await page.getByLabel('角色说明', { exact: true }).fill('协助整理文稿');
  await page.getByLabel('输出要求', { exact: true }).fill('清晰简洁');
  await page.getByLabel('分类', { exact: true }).fill('文稿');
  await page.getByLabel('图标', { exact: true }).selectOption('book');
  await page.getByLabel('收藏应用', { exact: true }).check();
  await page.getByRole('button', { name: '保存应用草稿', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '草稿已保存' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '发布配置版本', exact: true }).isDisabled(), true);
  const card = page.getByTestId('app-card').filter({ hasText: '桌面写作助手' });
  await card.getByText('配置未完成', { exact: true }).waitFor();
  // Controlled no-auth profile: configuration-only acceptance, no connection test or model request.
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('显示名称', { exact: true }).fill('应用配置测试模型');
  await page.getByLabel('协议', { exact: true }).selectOption('local-openai');
  await page.getByLabel('模型 ID', { exact: true }).fill('controlled-not-live-tested');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '刷新模型选项', exact: true }).click();
  await page.getByLabel('应用模型', { exact: true }).selectOption({ label: '应用配置测试模型 · controlled-not-live-tested · v1' });
  await page.getByRole('button', { name: '保存应用草稿', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '草稿已保存' }).waitFor();
  await page.getByRole('button', { name: '发布配置版本', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '配置版本已发布；未进行端到端试运行' }).waitFor();
  await card.getByText('可使用（配置就绪）', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  await page.getByLabel('搜索应用', { exact: true }).fill('中文描述');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await card.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
  await card.getByRole('button', { name: '打开应用', exact: true }).click();
  await page.getByTestId('app-space').getByText('聊天与新建会话尚未接入；未进行端到端试运行。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '新建对话（尚未接入）', exact: true }).isDisabled(), true);
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.pid, pid);
  await page.getByRole('button', { name: '返回应用首页', exact: true }).click();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('应用名称', { exact: true }).fill('桌面改名助手');
  await page.getByRole('button', { name: '保存应用草稿', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '草稿已保存' }).waitFor();
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  // Restart the real sidecar, then remount UI; no in-memory storage can satisfy this check.
  process.kill(pid);
  await page.waitForFunction(() => document.querySelector('[data-testid="phase"]').getAttribute('data-phase') === 'failed');
  await wait(300); await page.getByRole('button', { name: '重试服务', exact: true }).click(); await ready(page);
  await page.reload(); await ready(page);
  const renamed = page.getByTestId('app-card').filter({ hasText: '桌面改名助手' });
  await renamed.getByRole('button', { name: '取消收藏', exact: true }).waitFor();
  await renamed.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByTestId('app-feedback').filter({ hasText: '模型关联和外部目录授权需重新配置' }).waitFor();
  assert.equal(await page.getByLabel('应用模型', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
  const original = page.getByTestId('app-card').filter({ has: page.getByRole('heading', { name: '▤ 桌面改名助手', exact: true }) });
  await original.getByRole('button', { name: '归档', exact: true }).click();
  await original.waitFor({ state: 'detached' });
  await page.getByLabel('查看已归档', { exact: true }).check();
  await original.getByText('已归档', { exact: true }).waitFor();
  assert.equal(await original.getByRole('button', { name: '打开应用', exact: true }).isDisabled(), true);
  await original.getByRole('button', { name: '恢复', exact: true }).click();
  await original.waitFor({ state: 'detached' });
  await page.getByLabel('查看已归档', { exact: true }).uncheck(); await original.waitFor();
  const invalid = await page.evaluate(() => window.desktop.apps({ operation: 'writeFile', path: 'x' }));
  assert.equal(invalid.error.code, 'INVALID_INPUT');
});

test('P17 production settings: manual save/probe, revision invalidation and transient key clearing', { timeout: 60000 }, async t => {
  let requests = 0;
  const authorization = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    requests++;
    authorization.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { page } = await launch(t); await ready(page);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByLabel('显示名称').fill('Local UI test');
  await page.getByLabel('协议', { exact: true }).selectOption('local-openai');
  await page.getByLabel('端点', { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('模型 ID', { exact: true }).fill('test-model');
  assert.equal(requests, 0);
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  assert.equal(requests, 0);
  await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
  await page.getByTestId('provider-result').filter({ hasText: '连接成功' }).waitFor();
  assert.equal(requests, 1);
  await page.getByLabel('模型 ID', { exact: true }).fill('edited-model');
  assert.equal(await page.getByTestId('provider-result').count(), 0);
  assert.equal(await page.getByRole('button', { name: '测试模型连接', exact: true }).isDisabled(), true);
  await page.getByLabel('认证方式', { exact: true }).selectOption('api-key');
  await page.getByLabel('API Key', { exact: true }).fill('transient-ui-test-key');
  // Invalid request must still clear the password immediately and never touch browser storage.
  await page.getByLabel('模型 ID', { exact: true }).fill('');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('input[type=password]')?.value === '');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  await page.getByTestId('provider-feedback').filter({ hasText: '请求格式无效' }).waitFor();
  await page.getByLabel('模型 ID', { exact: true }).fill('edited-model');
  await page.getByLabel('API Key', { exact: true }).fill('saved-ui-test-key');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await page.getByTestId('provider-feedback').filter({ hasText: '已保存' }).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
  await page.getByTestId('provider-result').filter({ hasText: '连接成功' }).waitFor();
  assert.deepEqual(authorization, [undefined, 'Bearer saved-ui-test-key']);
  await page.getByLabel('API Key', { exact: true }).fill('leave-page-test-key');
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  assert.equal(requests, 2);
  assert.equal((await page.evaluate(() => window.desktop.providers({ operation: 'readCredential' }))).error.code, 'INVALID_INPUT');
});

test('F01/F02/F03/F10/F11 production Electron: real call chain, sandbox, reload and single instance', { timeout: 60000 }, async (t) => {
  const { app, page, profile } = await launch(t); await ready(page);
  await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByTestId('diagnostic').filter({ hasText: 'Node 24.19.0' }).waitFor();
  const initial = await page.evaluate(() => window.desktop.getStatus());
  const pid = initial.value.pid;
  const surface = await page.evaluate(() => ({ keys: Object.keys(window.desktop).sort(), require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer }));
  assert.deepEqual(surface, { keys: ['apps', 'getStatus', 'onStatusChanged', 'ping', 'providers', 'retryService'], require: 'undefined', process: 'undefined', ipc: 'undefined' });
  const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  for (const key of ['sandbox', 'contextIsolation', 'webSecurity']) assert.equal(prefs[key], true);
  for (const key of ['nodeIntegration', 'nodeIntegrationInWorker', 'nodeIntegrationInSubFrames', 'webviewTag', 'allowRunningInsecureContent']) assert.equal(prefs[key], false, key);
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.openDevTools({ mode: 'detach' });
    return contents.isDevToolsOpened();
  }), false);
  assert.equal((await page.evaluate(() => window.desktop.ping({ text: 'x', exec: 'bad' }))).error.code, 'INVALID_INPUT');
  assert.equal(await page.evaluate(async () => { try { await fetch('file:///C:/Windows/win.ini'); return true; } catch { return false; } }), false);
  assert.equal(await page.evaluate(async () => { try { await fetch('https://example.com'); return true; } catch { return false; } }), false);
  await page.evaluate(() => window.open('https://example.com'));
  assert.equal(app.windows().length, 1);
  // A second real renderer with a test-only probe cannot impersonate the owning window.
  const probe = join(profile, 'probe.cjs');
  await writeFile(probe, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',()=>ipcRenderer.invoke('foundation:status',{}));");
  const foreignPagePromise = app.waitForEvent('window');
  await app.evaluate(async ({ BrowserWindow }, preload) => {
    const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await other.loadURL('app://desktop/index.html');
  }, probe);
  const foreignPage = await foreignPagePromise;
  assert.equal((await foreignPage.evaluate(() => window.probe())).error.code, 'FORBIDDEN');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isVisible()).destroy());
  for (let i = 0; i < 3; i++) { await page.reload(); await ready(page); assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.pid, pid); }
  const second = spawn(electronPath, [resolve('dist'), `--user-data-dir=${profile}`], { env: environment(), stdio: 'ignore', windowsHide: true });
  const [exitCode] = await once(second, 'exit'); assert.equal(exitCode, 0);
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.pid, pid);
  assert.equal(app.windows().length, 1);
  // Normal window close must shut down the actual sidecar.
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed; await until(() => !alive(pid));
});

test('F06/F07/F08/F12 real crash notification, subscription cleanup, manual retry and Main crash cleanup', { timeout: 60000 }, async (t) => {
  const { app, page } = await launch(t); await ready(page);
  await page.evaluate(() => {
    window.events = [];
    window.removedEvents = [];
    const off = window.desktop.onStatusChanged((s) => window.removedEvents.push(s)); off(); off();
    window.desktop.onStatusChanged((s) => window.events.push(s));
  });
  const old = (await page.evaluate(() => window.desktop.getStatus())).value.pid;
  process.kill(old);
  await page.waitForFunction(() => document.querySelector('[data-testid="phase"]').getAttribute('data-phase') === 'failed');
  assert.equal(await page.getByRole('button', { name: '检查连接' }).isDisabled(), true);
  assert.equal((await page.evaluate(() => window.desktop.ping({ text: 'no replay' }))).error.code, 'NOT_READY');
  await wait(300);
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.phase, 'failed');
  await page.getByRole('button', { name: '重试服务' }).click(); await ready(page);
  const current = (await page.evaluate(() => window.desktop.getStatus())).value.pid;
  assert.notEqual(current, old);
  const events = await page.evaluate(() => ({ kept: window.events, removed: window.removedEvents }));
  assert.deepEqual(events.removed, []);
  assert.deepEqual(events.kept.map((s) => s.phase), ['failed', 'starting', 'ready']);
  // Electron's launcher PID can differ from its actual Main PID on Windows.
  const mainPid = await app.evaluate(() => process.pid);
  process.kill(mainPid);
  await until(() => !alive(current));
});

test('F05/F07/F14 missing sidecar is visible and retryable in a Chinese and spaced application path', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(resolve('.test-app-中文 空格-'));
  await cp(resolve('dist'), root, { recursive: true });
  const runtime = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  await rename(runtime, `${runtime}.disabled`);
  const { page } = await launch(t, root);
  // Hooks run in registration order; close the application before deleting its runtime.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await page.waitForFunction(() => document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase') === 'failed');
  assert.equal((await page.evaluate(() => window.desktop.getStatus())).value.error.code, 'START_FAILED');
  await rename(`${runtime}.disabled`, runtime);
  await page.getByRole('button', { name: '重试服务' }).click(); await ready(page);
  assert.equal((await page.evaluate(() => window.desktop.ping({ text: '中文路径' }))).value.text, '中文路径');
});
