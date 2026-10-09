import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const executable = process.env.AIAPPNEST_TEST_EXECUTABLE;
test('release package: actual executable has sandbox/CSP/preload, private Node SQLite and DPAPI', {skip:!executable, timeout:90000}, async t => {
  const root=resolve(process.env.AIAPPNEST_TEST_RUNTIME), profile=await mkdtemp(resolve('.test-packaged-中文 空格-'));
  let app;
  t.after(async()=>{if(app)await app.close();await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
  // No system Node/Pi/npm PATH and no ambient model credentials.
  app=await _electron.launch({executablePath:executable,args:[`--user-data-dir=${profile}`],env,timeout:30000});
  const page=await app.firstWindow();await page.waitForFunction(()=>document.querySelector('[data-testid="phase"]')?.getAttribute('data-phase')==='ready');
  assert.equal(await app.evaluate(({app})=>app.isPackaged),true);
  assert.equal(await app.evaluate(()=>process.versions.electron),'44.5.1');
  const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  assert.equal((await page.evaluate(()=>window.desktop.ping({text:'发行路径'}))).value.nodeVersion,'24.19.0');
  const csp=await app.evaluate(async({net})=> (await net.fetch('app://desktop/index.html')).headers.get('content-security-policy'));
  assert.ok(csp?.includes("default-src 'none'"));
  const result=await page.evaluate(async()=>window.desktop.providers({operation:'save',input:{config:{name:'DPAPI package probe',providerType:'openai',endpoint:'https://example.invalid/v1',modelId:'fixture',authMode:'api-key',settings:{timeoutMs:10000}},credential:{action:'replace',key:'release-fixture-not-a-secret'}}}));
  assert.equal(result.ok,true,JSON.stringify(result));
  const engine=JSON.parse(await readFile(join(root,'engine-runtime.json'),'utf8'));
  assert.equal(engine.cli,'node_modules/@mariozechner/pi-coding-agent/dist/cli.js');
  const sqlite=JSON.parse(execFileSync(join(root,'runtime/node.exe'),['-e',"const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE VIRTUAL TABLE t USING fts5(v)');console.log(JSON.stringify({node:process.versions.node,abi:process.versions.modules}));db.close()"],{env,encoding:'utf8'}));
  assert.equal(sqlite.node,'24.19.0');
  const manifest = JSON.parse(await readFile(join(root, 'release-manifest.json'), 'utf8'));
  assert.equal(sqlite.abi, manifest.nodeABI);
  const credentialHost = join(root, 'credential-host.exe');
  const clear = Buffer.from('release-fixture-not-a-secret').toString('base64');
  const cipher = execFileSync(credentialHost, ['protect'], {env, input: clear, encoding: 'utf8', windowsHide: true});
  assert.notEqual(cipher, clear);
  assert.equal(execFileSync(credentialHost, ['unprotect'], {env, input: cipher, encoding: 'utf8', windowsHide: true}), clear);
});
