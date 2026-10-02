import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import electronPath from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

test('F14 development build starts real Electron and Node without a dev server', { timeout: 60000 }, async () => {
  const root = await mkdtemp(resolve('.test-dev-'));
  let app;
  let closed = false;
  try {
    await promisify(execFile)(process.execPath, ['scripts/build.mjs', '--dev', `--out-dir=${root}`]);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    app = await electron.launch({ executablePath: electronPath, args: [root, `--user-data-dir=${join(root, 'profile')}`], env });
    app.on('close', () => { closed = true; });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase') === 'ready');
    assert.equal((await page.evaluate(() => window.desktop.ping({ text: 'dev' }))).value.text, 'dev');
    const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    assert.equal(await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const opened = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        contents.once('devtools-opened', () => { clearTimeout(timer); resolve(true); });
      });
      contents.openDevTools({ mode: 'detach' });
      return opened;
    }), true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.closeDevTools());
    assert.equal(page.url(), 'app://desktop/index.html');
  } finally { if (app && !closed) await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
