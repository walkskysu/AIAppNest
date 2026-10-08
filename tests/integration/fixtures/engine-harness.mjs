import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const bundle = mkdtempSync(resolve('.test-engine-bundle-'));
await build({ entryPoints: ['tests/integration/fixtures/engine-entry.ts'], outfile: join(bundle, 'entry.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' });
export const { Recovery, DiagnosticLog, diagnostics, activeTimeout, readSession, projectionId, DomainError, MemoryService, estimateTokens, keywords, memoryText, memoryHash, FileService, fileLimits, ChatService, RunFeed, safeExternal, shouldSubmit, RunScheduler, Storage, AppService, SkillRegistry, ProviderService, PolicyService, PiAdapter, readEngineRuntime, JsonlDecoder } = await import(pathToFileURL(join(bundle, 'entry.mjs')));
after(() => rmSync(bundle, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
export const runtime = readEngineRuntime(resolve('dist'));
export const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
export const until = async predicate => { const end = Date.now() + 15000; while (!predicate()) { assert.ok(Date.now() < end, 'condition timed out'); await delay(10); } };

// Deterministic HTTP model fixture; Pi, JSONL, permissions, files and Windows processes are real.
export async function fixture(t, options = {}) {
  const requests = [], sockets = new Set();
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push({ body, headers: request.headers });
    const last = body.messages.at(-1), text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');
    if (text === 'slow') { response.on('close', () => {}); return; }
    if (text === 'model-error') { response.writeHead(500); response.end('fixture failure'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null, usage) => response.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n');
    if (options.fileFlow && last.role === 'user' && text.includes('<attachment ')) {
      const match = text.match(/<attachment id="[^"]+">\n([\s\S]*?)\n<\/attachment>/);
      assert.ok(match, 'model fixture received managed input');
      const grant = JSON.parse(text.slice(0,text.indexOf('\n'))).grantId;
      send({ role:'assistant',tool_calls:[{ index:0,id:randomUUID(),type:'function',function:{ name:'platform_output',arguments:JSON.stringify({ grantId:grant,path:'fixture-result.txt',content:`copied:${match[1]}` }) } }] });
      send({},'tool_calls');
    } else if (typeof text === 'string' && text.startsWith('tool:') && last.role === 'user') {
      const tool = JSON.parse(text.slice(5).split('\n')[0]);
      send({ role: 'assistant', tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
      send({}, 'tool_calls');
    } else {
      let answer = last.role === 'tool' ? 'Recovered from tool result.' : `你好 🌏 ${text}`;
      if (text === 'recall') answer = body.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('')).join('|');
      if (text === 'large') answer = '界'.repeat(150000);
      send({ role: 'assistant', content: '' });
      for (let i = 0; i < answer.length; i += 4096) send({ content: answer.slice(i, i + 4096) });
      send({}, text === 'length' ? 'length' : 'stop', { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
    }
    response.end('data: [DONE]\n\n');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const root = mkdtempSync(resolve('.test-engine-中文 空格-')), storage = new Storage(join(root, 'data'));
  const secret = options.secret;
  const providers = new ProviderService(storage, { collect() {}, create() { return `secret:${randomUUID()}`; }, read() { return secret; }, remove() {} });
  const profile = ok(await providers.request({ operation: 'save', input: {
    config: { name: 'fixture', providerType: 'local-openai', endpoint: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'fixture',
      authMode: secret ? 'api-key' : 'none', settings: { timeoutMs: 10000 } }, credential: secret ? { action: 'replace', key: secret } : { action: 'clear' },
  } })).profile;
  const apps = new AppService(storage, providers), metadata = { name: 'Engine fixture', description: '', icon: 'book', category: '', favorite: false };
  let app = ok(apps.request({ operation: 'create', metadata })).app;
  app = ok(apps.request({ operation: 'update', appId: app.id, expectedVersion: app.version, metadata,
    draft: { ...app.draft, memory:options.memory ?? app.draft.memory, role: options.role ?? 'Original role', permissions: options.permissions ?? { mode: 'chat', tools: [] },
      model: { providerProfileId: profile.id, expectedRevision: profile.revision, temperature: 0, maxOutputTokens: 1024 } } })).app;
  if (options.skillBody) {
    const registry = new SkillRegistry(storage), source = join(root, 'skill-source'), owner = randomUUID(); mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), `---\nname: identity\ndescription: fixture skill\n---\n${options.skillBody}\n`);
    const selection = ok(registry.request({ operation: 'select', path: source, owner, scope: 'skill-import' })).selection;
    const skill = ok(registry.request({ operation: 'request', owner, request: { operation: 'import', token: selection.token } })).reply.skill;
    app = ok(apps.request({ operation: 'bindSkills', appId: app.id, expectedVersion: app.version,
      skills: [{ id: skill.id, version: skill.version, hash: skill.sha256, enabled: true, invocationMode: 'explicit' }] })).app;
  }
  app = ok(apps.request({ operation: 'publish', appId: app.id, expectedVersion: app.version })).app;
  const conversation = storage.createConversation(app.id, randomUUID(), 'test');
  const files = new FileService(storage);
  const policy = new PolicyService(storage, (a, r) => apps.readRevision(a, r), options.files ? { registerOutput:(scope,path) => files.registerOutput(scope,path).id } : {});
  const services = { storage, apps, providers, policy, files }, workers = [], schedulers = [];
  let previousRun;
  const run = () => {
    // Minimal scheduler: retire the previous fixture run before admitting the next.
    if (previousRun) storage.transitionRun(app.id, previousRun, 3, 'interrupted');
    const now = Date.now(), record = storage.createRun({ id: randomUUID(), appId: app.id, conversationId: conversation.id, requestId: randomUUID(),
      state: 'queued', phase: 'created', version: 1, createdAt: now, startedAt: null, endedAt: null, error: null, usage: null });
    storage.transitionRun(app.id, record.id, 1, 'starting'); storage.transitionRun(app.id, record.id, 2, 'running'); previousRun = record.id; return record.id;
  };
  const start = async (restore = false, adapterOptions = {}) => {
    const worker = await PiAdapter[restore ? 'restore' : 'start'](services, runtime, app.id, conversation.id, adapterOptions); workers.push(worker); return worker;
  };
  const owner = randomUUID();
  const policyRequest = input => ok(policy.request({ operation: 'request', owner, request: { appId: app.id, conversationId: conversation.id, ...input } })).reply;
  t.after(async () => {
    for (const scheduler of schedulers) await scheduler.close();
    for (const worker of workers) await worker.close(true);
    policy.close(); storage.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, storage, apps, app, conversation, services, start, run, requests, metadata, policyRequest, schedulers };
}
