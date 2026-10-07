import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, symlinkSync, linkSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { registerApiProvider, createAssistantMessageEventStream, unregisterApiProviders } from '@mariozechner/pi-ai';
import { ServiceManager } from '../../dist/service-manager.cjs';

const bundle = mkdtempSync(resolve('.test-policy-bundle-'));
after(() => rmSync(bundle, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
await build({ entryPoints: ['tests/integration/fixtures/policy-entry.ts'], outfile: join(bundle, 'entry.mjs'), bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['@mariozechner/*', 'yaml', 'zod'] });
const { Storage, AppService, ProviderService, PolicyService, createPolicySession, policyRequestSchema, trustedBoundaryNotice } = await import(pathToFileURL(join(bundle, 'entry.mjs')));
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const metadata = { name: 'Policy 测试', description: '', icon: 'book', category: '', favorite: false };
async function fixture(t, mode = 'controlled-files', tools = ['read', 'write'], options = {}) {
  const root = mkdtempSync(resolve('.test-policy-中文 空格-')), storage = new Storage(join(root, 'data'));
  const providers = new ProviderService(storage, { collect() {}, create() { throw Error('no secrets'); }, read() { throw Error('no secrets'); }, remove() {} });
  const provider = ok(await providers.request({ operation: 'save', input: { config: { name: 'fixture', providerType: 'local-openai', endpoint: 'http://127.0.0.1:11434/v1', modelId: 'fixture', authMode: 'none', settings: { timeoutMs: 3000 } }, credential: { action: 'clear' } } })).profile;
  const apps = new AppService(storage, providers);
  let app = ok(apps.request({ operation: 'create', metadata })).app;
  app = ok(apps.request({ operation: 'update', appId: app.id, expectedVersion: app.version, metadata,
    draft: { ...app.draft, role: 'Policy test', permissions: { mode, tools }, model: { providerProfileId: provider.id, expectedRevision: provider.revision, temperature: 0, maxOutputTokens: 1024 } } })).app;
  app = ok(apps.request({ operation: 'publish', appId: app.id, expectedVersion: app.version })).app;
  const conversation = storage.createConversation(app.id, randomUUID(), 'test');
  const scope = { appId: app.id, conversationId: conversation.id }, owner = randomUUID();
  const policy = new PolicyService(storage, (a, r) => apps.readRevision(a, r), options);
  const request = input => policy.request({ operation: 'request', owner, request: { ...scope, ...input } });
  const req = input => ok(request(input)).reply;
  const grant = (access, extra = {}) => req({ operation: 'grants.create', resource: 'workspace', access, confirmation: 'never', ...extra }).grant;
  const select = path => ok(policy.request({ operation: 'select', ...scope, owner, path, scope: 'policy-directory' })).selection;
  const run = () => {
    const now = Date.now();
    const value = storage.createRun({ id: randomUUID(), ...scope, requestId: randomUUID(), state: 'queued', phase: 'created', version: 1, createdAt: now, startedAt: null, endedAt: null, error: null, usage: null });
    storage.transitionRun(app.id, value.id, 1, 'starting'); storage.transitionRun(app.id, value.id, 2, 'running');
    return value.id;
  };
  const runId = run();
  t.after(() => { policy.close(); storage.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { root, storage, apps, app, policy, req, request, grant, select, scope, owner, runId,
    bind: () => policy.bindRun(app.id, runId),
    pending: () => req({ operation: 'approvals.list', runId }).approvals,
    decide: (approval, decision = 'allow', extra = {}) => request({ operation: 'approvals.decide', runId, approvalId: approval.id, digest: approval.digest, decision, ...extra }),
  };
}

test('Q01 chat has no tools, file entry and grants are denied', async t => {
  const f = await fixture(t, 'chat', []), boundary = f.bind();
  assert.deepEqual(boundary.tools, []);
  await assert.rejects(boundary.write('write', { grantId: randomUUID(), path: 'no', content: 'bad' }), /TOOL_DENIED/);
  assert.equal(f.request({ operation: 'grants.create', resource: 'workspace', access: 'read', confirmation: 'never' }).ok, false);
});

test('Q02 controlled file entry reads, lists, writes and creates output with distinct permissions', async t => {
  const f = await fixture(t), read = f.grant('read'), write = f.grant('write'), output = f.grant('write', { resource: 'output' });
  const boundary = f.bind();
  assert.deepEqual(boundary.tools, ['platform_read', 'platform_list', 'platform_write', 'platform_output']);
  await boundary.write('w', { grantId: write.id, path: '中文.txt', content: 'first' });
  assert.equal(await boundary.read('r', { grantId: read.id, path: '中文.txt' }), 'first');
  assert.deepEqual(await boundary.list('l', { grantId: read.id, path: '.' }), ['中文.txt']);
  await boundary.write('w2', { grantId: write.id, path: '中文.txt', content: 'new' });
  assert.equal(readFileSync(join(write.root, '中文.txt'), 'utf8'), 'new');
  await boundary.output('o', { grantId: output.id, path: 'report.txt', content: 'output' });
  await assert.rejects(boundary.output('o2', { grantId: output.id, path: 'report.txt', content: 'overwrite' }));
  assert.equal(readFileSync(join(output.root, 'report.txt'), 'utf8'), 'output');
  await assert.rejects(boundary.read('r2', { grantId: write.id, path: '中文.txt' }), /ACCESS_DENIED/);
});

test('Q03/Q04 Windows paths: traversal, prefix collisions, case, junctions, hardlinks and special forms', async t => {
  const f = await fixture(t), read = f.grant('read'), write = f.grant('write'), boundary = f.bind();
  writeFileSync(join(read.root, 'Good.txt'), 'safe');
  const sibling = `${read.root}-other`; mkdirSync(sibling); writeFileSync(join(sibling, 'secret.txt'), 'secret');
  for (const path of ['../workspace-other/secret.txt', '..\\workspace-other\\secret.txt', join(sibling, 'secret.txt'),
    '\\\\server\\share\\secret', '\\\\?\\C:\\Windows\\win.ini', '\\\\.\\NUL', 'C:relative', 'C:\\temp\\file:stream',
    'Good.txt:stream', 'NUL.txt', 'COM1', 'lpt¹.txt', 'trailing.', 'trailing ', 'SHORT~1/file', '\\Windows\\win.ini']) {
    await assert.rejects(boundary.read(randomUUID(), { grantId: read.id, path }));
    await assert.rejects(boundary.write(randomUUID(), { grantId: write.id, path, content: 'bad' }));
  }
  if (process.platform === 'win32') assert.equal(await boundary.read('case', { grantId: read.id, path: join(read.root, 'GOOD.TXT').toUpperCase().replaceAll('\\', '/') }), 'safe');
  symlinkSync(sibling, join(read.root, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(boundary.read('link', { grantId: read.id, path: 'jump/secret.txt' }), /LINK_OR_SPECIAL_FILE/);
  await assert.rejects(boundary.write('link-new', { grantId: write.id, path: 'jump/new.txt', content: 'bad' }), /LINK_OR_SPECIAL_FILE/);
  linkSync(join(sibling, 'secret.txt'), join(read.root, 'hard.txt'));
  await assert.rejects(boundary.write('hard', { grantId: write.id, path: 'hard.txt', content: 'bad' }), /LINK_OR_SPECIAL_FILE/);
  assert.equal(readFileSync(join(sibling, 'secret.txt'), 'utf8'), 'secret'); assert.equal(existsSync(join(sibling, 'new.txt')), false);
});

test('Q05/Q10 read grants cannot write/overwrite; delete/rename/shell and arbitrary exec IPC are absent', async t => {
  const f = await fixture(t), read = f.grant('read'), boundary = f.bind();
  writeFileSync(join(read.root, 'file'), 'original');
  await assert.rejects(boundary.write('write', { grantId: read.id, path: 'file', content: 'secret-payload' }), /ACCESS_DENIED/);
  for (const tool of ['delete', 'rename', 'bash', 'exec']) {
    assert.equal(boundary[tool], undefined);
    assert.equal(policyRequestSchema.safeParse({ ...f.scope, operation: tool, path: join(read.root, 'file') }).success, false);
  }
  assert.equal(readFileSync(join(read.root, 'file'), 'utf8'), 'original');
  assert.doesNotMatch(JSON.stringify(f.storage.events.list({ runId: f.runId })), /secret-payload|original/);
});

test('Q06 tokens bind owner, conversation, purpose and expiry; cannot inject absolute paths', async t => {
  let now = Date.now(); const f = await fixture(t, 'controlled-files', ['read', 'write'], { now: () => now });
  const external = join(f.root, 'external'); mkdirSync(external); const selection = f.select(external);
  const create = { ...f.scope, operation: 'grants.create', resource: 'external', access: 'read', confirmation: 'never', token: selection.token };
  assert.equal(f.policy.request({ operation: 'request', owner: randomUUID(), request: create }).ok, false);
  assert.equal(f.request({ ...create, conversationId: randomUUID() }).ok, false);
  assert.equal(f.request({ ...create, path: external }).error.code, 'INVALID_INPUT');
  assert.equal(f.policy.request({ operation: 'select', ...f.scope, owner: f.owner, path: external, scope: 'skill-import' }).ok, false);
  ok(f.request(create)); assert.equal(f.request(create).ok, false);
  const expired = f.select(external); now += 300001; assert.equal(f.request({ ...create, token: expired.token }).ok, false);
});

test('Q06 confirmations suspend calls, bind parameters/ownership, survive refresh and consume once', async t => {
  const f = await fixture(t), grant = f.grant('write', { confirmation: 'always' }), boundary = f.bind();
  const args = { grantId: grant.id, path: 'allowed.txt', content: 'sensitive-content' };
  const pending = boundary.write('bound-call', args); args.path = 'changed.txt'; args.content = 'changed';
  const [approval] = f.pending(); assert.equal(approval.state, 'pending');
  assert.deepEqual(f.pending(), [approval]); assert.equal(existsSync(join(grant.root, 'allowed.txt')), false);
  assert.equal(f.decide(approval, 'allow', { digest: '0'.repeat(64) }).ok, false);
  assert.equal(f.decide(approval, 'allow', { appId: randomUUID() }).ok, false);
  assert.equal(f.decide(approval, 'allow', { runId: randomUUID() }).ok, false);
  ok(f.decide(approval)); assert.equal(f.decide(approval).ok, false); await pending;
  assert.equal(readFileSync(join(grant.root, 'allowed.txt'), 'utf8'), 'sensitive-content');
  assert.equal(existsSync(join(grant.root, 'changed.txt')), false); assert.equal(f.pending()[0].state, 'consumed');
  await assert.rejects(boundary.write('bound-call', args), /CALL_REPLAY/);
  const second = boundary.write('another-call', args); const secondApproval = f.pending().find(a => a.state === 'pending');
  assert.notEqual(secondApproval.digest, approval.digest); assert.equal(f.decide(approval).ok, false);
  ok(f.decide(secondApproval, 'deny')); await assert.rejects(second, /APPROVAL_DENIED/);
  assert.equal(existsSync(join(grant.root, 'changed.txt')), false);
  const events = f.storage.events.list({ runId: f.runId });
  assert.ok(events.some(e => e.type === 'policy.waiting')); assert.ok(events.some(e => e.type === 'policy.resolved'));
  assert.doesNotMatch(JSON.stringify(events), /sensitive-content/);
  assert.equal(f.request({ operation: 'approvals.decide', runId: f.runId, approvalId: approval.id, digest: approval.digest, decision: 'allow', approved: true }).ok, false);
});

test('Q06/Q07 expiration, cancellation, revocation and disconnect never resume writes', async t => {
  for (const action of ['expire', 'cancel', 'revoke', 'disconnect', 'signal']) {
    const f = await fixture(t, 'controlled-files', ['read', 'write'], { approvalMs: 35 });
    const grant = f.grant('write', { confirmation: 'always' }), boundary = f.bind(), controller = new AbortController();
    const pending = boundary.write(action, { grantId: grant.id, path: 'never.txt', content: 'bad' }, controller.signal);
    const rejected = assert.rejects(pending); const [approval] = f.pending();
    if (action === 'expire') await delay(65);
    if (action === 'cancel') boundary.cancel();
    if (action === 'signal') controller.abort();
    if (action === 'revoke') f.req({ operation: 'grants.revoke', grantId: grant.id, expectedVersion: grant.version });
    if (action === 'disconnect') f.policy.close();
    await rejected;
    assert.equal(existsSync(join(grant.root, 'never.txt')), false); assert.equal(f.decide(approval).ok, false);
    await assert.rejects(boundary.write('after', { grantId: grant.id, path: 'never.txt', content: 'bad' }));
  }
});

test('Q07 final path recheck catches a junction swapped during confirmation', async t => {
  const f = await fixture(t), grant = f.grant('write', { confirmation: 'always' }), boundary = f.bind();
  const directory = join(grant.root, 'folder'), outside = join(f.root, 'outside'); mkdirSync(directory); mkdirSync(outside);
  writeFileSync(join(outside, 'target'), 'original');
  const pending = boundary.write('swap', { grantId: grant.id, path: 'folder/target', content: 'bad' });
  const [approval] = f.pending(); renameSync(directory, `${directory}-old`); symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  ok(f.decide(approval)); await assert.rejects(pending, /LINK_OR_SPECIAL_FILE/);
  assert.equal(readFileSync(join(outside, 'target'), 'utf8'), 'original');
});

test('Q08 immutable revisions bound old conversations; corrupted snapshot prevents run binding', async t => {
  const f = await fixture(t, 'controlled-files', ['read']);
  const app = ok(f.apps.request({ operation: 'update', appId: f.app.id, expectedVersion: f.app.version, metadata,
    draft: { ...f.app.draft, permissions: { mode: 'trusted-automation', tools: ['read', 'write', 'shell'] } } })).app;
  ok(f.apps.request({ operation: 'publish', appId: app.id, expectedVersion: app.version }));
  assert.deepEqual(f.bind().tools, ['platform_read', 'platform_list']);
  assert.equal(f.request({ operation: 'grants.create', access: 'write', resource: 'workspace', confirmation: 'never' }).ok, false);
  const g = await fixture(t); const path = g.storage.paths.revision(g.app.id, g.app.currentRevisionId);
  writeFileSync(join(path, 'manifest.json'), '{}'); assert.throws(() => g.bind());
});

test('Q09 trusted mode requires explicit host consent and confirms each invocation; revoke is immediate', async t => {
  const f = await fixture(t, 'trusted-automation', ['read', 'write', 'shell']);
  assert.throws(() => f.bind(), /EXPLICIT_TRUST_REQUIRED/);
  assert.equal(f.request({ operation: 'grants.create', resource: 'workspace', access: 'write', confirmation: 'never' }).ok, false);
  assert.equal(f.request({ operation: 'trust', notice: trustedBoundaryNotice }).ok, false);
  ok(f.policy.request({ operation: 'trust', ...f.scope, notice: trustedBoundaryNotice }));
  const boundary = f.bind(); assert.ok(boundary.tools.includes('bash'));
  let executed = 0;
  const pending = boundary.trusted('trusted', 'bash', { command: 'echo test' }, async () => ++executed);
  assert.equal(executed, 0); const [approval] = f.pending(); ok(f.decide(approval)); assert.equal(await pending, 1);
  f.req({ operation: 'trust.revoke' });
  await assert.rejects(boundary.trusted('later', 'bash', { command: 'echo test' }, async () => ++executed));
  assert.equal(executed, 1);
  assert.match(trustedBoundaryNotice, /账户文件和注入的凭据/);
});

// Only the model stream is deterministic. Pi's real extension/tool dispatch is used below.
const api = 'policy-fixture-api', provider = 'policy-fixture';
const model = { api, provider, id: 'fixture', name: 'Deterministic test stream', baseUrl: 'http://unused.invalid', reasoning: false,
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 };
const contexts = [];
function stream(model, context) {
  contexts.push(context); const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const last = context.messages.at(-1), text = typeof last?.content === 'string' ? last.content : last?.content?.filter(c => c.type === 'text').map(c => c.text).join('');
    const message = { role: 'assistant', api, provider, model: model.id, content: [{ type: 'text', text: 'done' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    if (last?.role === 'user' && text.startsWith('tool:')) {
      const input = JSON.parse(text.slice(5)); message.content = [{ type: 'toolCall', id: randomUUID(), name: input.name, arguments: input.args }]; message.stopReason = 'toolUse';
    }
    stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
  });
  return stream;
}
registerApiProvider({ api, stream, streamSimple: stream }, 'policy-tests');
after(() => unregisterApiProviders('policy-tests'));
async function engine(t, f, boundary = f.bind()) {
  const cwd = join(f.root, 'engine'), agentDir = join(f.root, 'agent'); mkdirSync(cwd); mkdirSync(agentDir);
  const events = [];
  const session = await createPolicySession({ boundary, cwd, agentDir, model, apiKey: 'non-secret-fixture', roleText: 'Policy test', onEvent: e => events.push(e) });
  t.after(() => session.close()); return { session, events };
}

test('Q01/Q02/Q10 real Pi loop: chat and controlled modes reject every generic tool; denied target stays unchanged', async t => {
  for (const mode of ['chat', 'controlled-files']) {
    const f = await fixture(t, mode, mode === 'chat' ? [] : ['read', 'write']);
    const grant = mode === 'chat' ? null : f.grant('read');
    const target = join(f.root, 'MUST_NOT_CHANGE'); writeFileSync(target, 'original');
    const { session } = await engine(t, f);
    for (const name of ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'delete', 'rename', 'skill_script']) {
      const messages = await session.prompt(`tool:${JSON.stringify({ name, args: { path: target, content: 'bad', command: 'echo bad' } })}`);
      assert.equal(messages.filter(m => m.role === 'toolResult').at(-1).isError, true, name);
      assert.equal(readFileSync(target, 'utf8'), 'original');
    }
    if (grant) {
      const messages = await session.prompt(`tool:${JSON.stringify({ name: 'platform_write', args: { grantId: grant.id, path: target, content: 'bad' } })}`);
      const result = messages.filter(m => m.role === 'toolResult').at(-1); assert.equal(result.isError, true); assert.match(JSON.stringify(result), /ACCESS_DENIED/);
      assert.equal(readFileSync(target, 'utf8'), 'original');
      t.diagnostic(JSON.stringify({ pi: '0.73.1', mode, tool: result.toolName, isError: result.isError, content: result.content, targetUnchanged: true }));
    }
    assert.deepEqual((contexts.at(-1).tools ?? []).map(tool => tool.name).sort(), [...session.tools].sort());
    assert.ok(f.storage.events.list({ runId: f.runId }).some(event => event.type === 'policy.decision' && event.payload.tool === 'bash' && event.payload.allowed === false));
    await session.close();
  }
});

test('Q08 real extension initialization errors prevent a usable session', async t => {
  const f = await fixture(t), boundary = f.bind(); let checks = 0;
  await assert.rejects(engine(t, f, { ...boundary, assertActive() { if (++checks >= 2) throw Error('injected extension init failure'); boundary.assertActive(); } }), /EXTENSION_INIT_FAILED/);
  await assert.rejects(boundary.read('after-fail', { grantId: randomUUID(), path: 'anything' }), /RUN_CANCELLED/);
});

test('Q02 real Pi success path uses platform entry; workspace extensions and settings are ignored', async t => {
  const f = await fixture(t), grant = f.grant('write'), read = f.grant('read');
  const cwd = join(f.root, 'poisoned'), agentDir = join(f.root, 'agent'); mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true }); mkdirSync(agentDir);
  const marker = join(f.root, 'EXTENSION_EXECUTED');
  writeFileSync(join(cwd, '.pi', 'extensions', 'bad.js'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export default pi => pi.registerTool({name:'escape'});`);
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ extensions: ['./extensions/bad.js'], tools: ['bash'] }));
  writeFileSync(join(cwd, 'AGENTS.md'), 'UNAPPROVED_POLICY_MARKER');
  writeFileSync(join(agentDir, 'SYSTEM.md'), 'UNAPPROVED_POLICY_MARKER');
  const session = await createPolicySession({ boundary: f.bind(), cwd, agentDir, model, apiKey: 'fixture', roleText: 'Explicit role' });
  try {
    const messages = await session.prompt(`tool:${JSON.stringify({ name: 'platform_write', args: { grantId: grant.id, path: 'engine.txt', content: 'engine-written' } })}`);
    assert.equal(messages.filter(m => m.role === 'toolResult').at(-1).isError, false);
    assert.equal(readFileSync(join(grant.root, 'engine.txt'), 'utf8'), 'engine-written');
    const readMessages = await session.prompt(`tool:${JSON.stringify({ name: 'platform_read', args: { grantId: read.id, path: 'engine.txt' } })}`);
    assert.match(JSON.stringify(readMessages.filter(m => m.role === 'toolResult').at(-1)), /engine-written/);
    assert.equal(existsSync(marker), false); assert.doesNotMatch(contexts.at(-1).systemPrompt, /UNAPPROVED_POLICY_MARKER/);
    assert.equal(session.setActiveTools, undefined); assert.equal(session.executeBash, undefined); assert.equal(session.reload, undefined);
  } finally { await session.close(); }
});

test('Q09 real Pi trusted built-ins are wrapped: deny has no side effect, allow writes after confirmation', async t => {
  const f = await fixture(t, 'trusted-automation', ['write']);
  ok(f.policy.request({ operation: 'trust', ...f.scope, notice: trustedBoundaryNotice }));
  const { session } = await engine(t, f); const target = join(f.root, 'trusted-write');
  try {
    for (const decision of ['deny', 'allow']) {
      const pending = session.prompt(`tool:${JSON.stringify({ name: 'write', args: { path: target, content: 'trusted content' } })}`);
      let approval;
      for (let tries = 0; tries < 100; tries++) { approval = f.pending().find(a => a.state === 'pending'); if (approval) break; await delay(10); }
      assert.ok(approval); assert.equal(existsSync(target), false); ok(f.decide(approval, decision));
      const messages = await pending;
      assert.equal(messages.filter(m => m.role === 'toolResult').at(-1).isError, decision === 'deny');
      assert.equal(existsSync(target), decision === 'allow');
    }
    assert.equal(readFileSync(target, 'utf8'), 'trusted content');
  } finally { await session.close(); }
});

test('Q06/Q07 startup cancels persisted pending/allowed approvals; production IPC persists grants and revocations', async t => {
  const f = await fixture(t), grant = f.grant('write', { confirmation: 'always' }), boundary = f.bind();
  const pending = boundary.write('persist', { grantId: grant.id, path: 'never', content: 'bad' });
  const rejected = assert.rejects(pending); const [approval] = f.pending(); f.policy.close(); await rejected;
  // Simulate crash between recording allow and consuming it, without running the side effect.
  f.storage.savePolicyRecord('approval', { ...approval, state: 'allowed' });
  const manager = new ServiceManager({ nodePath: process.execPath, entry: resolve('dist/service-host.cjs'), dataRoot: f.storage.paths.root, startupMs: 10000 });
  t.after(() => manager.stop()); ok(await manager.start());
  const req = async input => ok(await manager.policy({ operation: 'request', owner: f.owner, request: { ...f.scope, ...input } })).reply;
  assert.equal((await req({ operation: 'approvals.list', runId: f.runId })).approvals[0].state, 'cancelled');
  assert.equal((await req({ operation: 'grants.list' })).grants[0].id, grant.id);
  const next = (await req({ operation: 'grants.revoke', grantId: grant.id, expectedVersion: 1 })).grant;
  assert.equal(next.version, 2); assert.equal(next.revoked, true);
  assert.equal((await manager.policy({ operation: 'execute', tool: 'write', args: {} })).ok, false);
  await manager.stop();
  const restart = new PolicyService(f.storage, (a, r) => f.apps.readRevision(a, r));
  try {
    const grants = ok(restart.request({ operation: 'request', owner: f.owner, request: { ...f.scope, operation: 'grants.list' } })).reply.grants;
    assert.equal(grants[0].revoked, true); assert.equal(existsSync(join(grant.root, 'never')), false);
  } finally { restart.close(); }
});

test('Q06/Q07 approving then cancelling or changing grant before resume cannot write', async t => {
  for (const action of ['cancel', 'revoke', 'expire']) {
    let now = Date.now(); const f = await fixture(t, 'controlled-files', ['write'], { now: () => now });
    const grant = f.grant('write', { confirmation: 'always' }), boundary = f.bind();
    const pending = boundary.write(action, { grantId: grant.id, path: 'never', content: 'bad' });
    ok(f.decide(f.pending()[0]));
    if (action === 'cancel') boundary.cancel();
    if (action === 'revoke') f.req({ operation: 'grants.revoke', grantId: grant.id, expectedVersion: 1 });
    if (action === 'expire') now += 120001;
    await assert.rejects(pending); assert.equal(existsSync(join(grant.root, 'never')), false);
  }
});

test('Q02/Q06 foreign and newly added grants do not expand a bound run; forged identity parameters fail', async t => {
  const f = await fixture(t), read = f.grant('read'), boundary = f.bind();
  const write = f.grant('write');
  await assert.rejects(boundary.write('new-grant', { grantId: write.id, path: 'never', content: 'bad' }), /ACCESS_DENIED/);
  await assert.rejects(boundary.read('foreign-grant', { grantId: randomUUID(), path: 'anything' }), /ACCESS_DENIED/);
  await assert.rejects(boundary.read('forged-run', { grantId: read.id, path: 'anything', runId: f.runId }), /INVALID_ARGUMENTS/);
  await assert.rejects(boundary.trusted('script', 'bash', { command: 'echo bad' }, async () => { throw Error('MUST_NOT_EXECUTE'); }), /TOOL_DENIED/);
  assert.equal(existsSync(join(write.root, 'never')), false);
});

test('Q02 external grants cannot authorize platform database, credentials or runtime directories', async t => {
  const f = await fixture(t);
  for (const path of [f.storage.paths.root, f.root]) {
    const token = f.select(path).token;
    assert.equal(f.request({ operation: 'grants.create', resource: 'external', token, access: 'write', confirmation: 'never' }).ok, false);
  }
});

test('Q08 extension session_start failure is fail-closed even when Pi catches handler errors', async t => {
  const f = await fixture(t), boundary = f.bind(); let checks = 0;
  await assert.rejects(engine(t, f, { ...boundary, assertActive() { if (++checks >= 3) throw Error('injected startup failure'); boundary.assertActive(); } }), /EXTENSION_INIT_FAILED/);
  await assert.rejects(boundary.read('after-fail', { grantId: randomUUID(), path: 'anything' }), /RUN_CANCELLED/);
});
