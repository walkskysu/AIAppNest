// Explicit acceptance only. Read credentials through DPAPI from profiles saved in the desktop UI.
// Never accept a key in argv, print a thrown error, or export model request/response bodies.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const split = value.indexOf('='); return [value.slice(2, split), value.slice(split + 1)];
}));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const report = { checkedAt: new Date().toISOString(), pi: '0.73.1', gate: 'BLOCKED', code: 'MISSING_EXPLICIT_PROFILES', cloud: null, local: null };
let temporary, storage;
try {
  if (Object.keys(args).some(key => !['data-root', 'cloud', 'local'].includes(key)) || !args['data-root'] || !isAbsolute(args['data-root']) || !uuid.test(args.cloud ?? '') || !uuid.test(args.local ?? '')) {
    process.exitCode = 2;
  } else {
    temporary = mkdtempSync(resolve('.test-provider-live-'));
    await build({ entryPoints: ['tests/integration/fixtures/provider-entry.ts'], outfile: join(temporary, 'entry.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' });
    const { Storage, CredentialService, ProviderService, testRuntime } = createRequire(import.meta.url)(join(temporary, 'entry.cjs'));
    storage = new Storage(args['data-root']);
    const service = new ProviderService(storage, new CredentialService(storage.paths, resolve('dist/credential-host.exe')),
      runtime => testRuntime(runtime, resolve('dist/provider-probe.cjs')));
    // Validate both identities before making either network request.
    const cloud = storage.providers.get({ id: args.cloud }), local = storage.providers.get({ id: args.local });
    if (cloud.providerType !== 'openai' || cloud.authMode !== 'api-key' || local.providerType !== 'local-openai') throw new Error();
    for (const [name, profile] of [['cloud', cloud], ['local', local]]) {
      const result = await service.request({ operation: 'test', input: { id: profile.id, revision: profile.revision } });
      report[name] = result.ok ? { modelId: profile.modelId, revision: profile.revision, ...result.value.result, id: undefined } : { code: result.error.code };
    }
    report.gate = report.cloud.code === 'SUCCESS' && report.local.code === 'SUCCESS' && !report.cloud.stale && !report.local.stale ? 'PASS' : 'BLOCKED';
    report.code = report.gate === 'PASS' ? 'REAL_MODEL_TEXT_GENERATION_VERIFIED' : 'MODEL_TEST_FAILED';
    // Each run has its own ignored evidence directory; do not overwrite earlier evidence.
    writeFileSync(join(temporary, 'report.json'), JSON.stringify(report, null, 2));
    if (report.gate !== 'PASS') process.exitCode = 2;
  }
} catch {
  report.code = 'PROFILE_OR_CREDENTIAL_UNAVAILABLE'; process.exitCode = 2;
  if (temporary) writeFileSync(join(temporary, 'report.json'), JSON.stringify(report, null, 2));
} finally {
  storage?.close();
  if (temporary) rmSync(join(temporary, 'entry.cjs'), { force: true });
}
console.log(JSON.stringify(report));
