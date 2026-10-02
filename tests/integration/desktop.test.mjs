import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, rm, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

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

test('F01/F02/F03/F10/F11 production Electron: real call chain, sandbox, reload and single instance', { timeout: 60000 }, async (t) => {
  const { app, page, profile } = await launch(t); await ready(page);
  await page.getByRole('button', { name: '检查连接' }).click();
  await page.getByTestId('diagnostic').filter({ hasText: 'Node 24.19.0' }).waitFor();
  const initial = await page.evaluate(() => window.desktop.getStatus());
  const pid = initial.value.pid;
  const surface = await page.evaluate(() => ({ keys: Object.keys(window.desktop).sort(), require: typeof window.require, process: typeof window.process, ipc: typeof window.ipcRenderer }));
  assert.deepEqual(surface, { keys: ['getStatus', 'onStatusChanged', 'ping', 'retryService'], require: 'undefined', process: 'undefined', ipc: 'undefined' });
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
