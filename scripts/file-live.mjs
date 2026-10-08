// Explicit real-model acceptance. Never discovers personal profiles or accepts plaintext credentials.
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const args = Object.fromEntries(process.argv.slice(2).map(value => { const i = value.indexOf('='); return [value.slice(2,i),value.slice(i+1)]; }));
const report = { checkedAt:new Date().toISOString(),node:process.versions.node,pi:'0.73.1',model:'real',gate:'BLOCKED',code:'MISSING_EXPLICIT_TEST_APP',
  attachmentCopied:false,runSucceeded:false,artifactMatched:false };
const ok = r => { if (!r.ok) throw Error(r.error.code); return r.value; };
let storage,policy,scheduler,files;
try {
  if (Object.keys(args).some(key => !['data-root','app'].includes(key)) || !isAbsolute(args['data-root'] ?? '') || !/^[0-9a-f-]{36}$/.test(args.app ?? '')) process.exitCode = 2;
  else {
    const directory = mkdtempSync(resolve('.test-file-live-')), entry = join(directory,'entry.mjs');
    await build({ entryPoints:['tests/integration/fixtures/engine-entry.ts'],outfile:entry,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent' });
    const { Storage,AppService,ProviderService,CredentialService,FileService,PolicyService,RunScheduler,readEngineRuntime } = await import(pathToFileURL(entry));
    storage = new Storage(args['data-root']);
    if (storage.unfinishedRuns().length) throw Error('TEST_DATA_HAS_ACTIVE_RUNS');
    const providers = new ProviderService(storage,new CredentialService(storage.paths,resolve('dist/credential-host.exe'))),apps = new AppService(storage,providers);
    const app = storage.apps.get({ id:args.app });
    if (app.status !== 'ready' || !app.currentRevisionId) throw Error('TEST_APP_NOT_PUBLISHED');
    const revision = apps.readRevision(app.id,app.currentRevisionId);
    if (revision.snapshot.config.permissions.mode !== 'controlled-files' || !revision.snapshot.config.permissions.tools.includes('write')) throw Error('TEST_REQUIRES_CONTROLLED_WRITE_APP');
    const conversation = storage.createConversation(app.id,randomUUID(),'File explicit live acceptance'),scope = { appId:app.id,conversationId:conversation.id },owner = randomUUID();
    files = new FileService(storage);
    policy = new PolicyService(storage,(a,r) => apps.readRevision(a,r),{ registerOutput:(scope,path) => files.registerOutput(scope,path).id });
    const grant = ok(policy.request({ operation:'request',owner,request:{ operation:'grants.create',...scope,resource:'output',access:'write',confirmation:'never' } })).reply.grant;
    const marker = `file-acceptance-${randomUUID()}`,path = join(directory,'input.txt'); writeFileSync(path,marker);
    const selection = ok(await files.request({ operation:'select',owner,...scope,path })).selection;
    const attachment = ok(await files.request({ operation:'request',owner,request:{ operation:'attachments.import',...scope,token:selection.token } })).reply.file;
    writeFileSync(path,'original changed after import');
    report.attachmentCopied = files.attachmentText(scope,[attachment.id]).includes(marker);
    scheduler = new RunScheduler({ storage,apps,providers,policy,files },readEngineRuntime(resolve('dist')));
    const run = ok(scheduler.request({ operation:'submit',...scope,revisionId:conversation.revisionId,requestId:randomUUID(),attachmentIds:[attachment.id],
      text:`Read the attached text and use platform_output exactly once with grantId ${grant.id}, path acceptance.txt, and content equal to the complete attachment text. Do not use other tools. Then give a short confirmation.` })).run;
    const deadline = Date.now()+120000;
    while (Date.now() < deadline && storage.runs.get({ appId:app.id,id:run.id }).phase !== 'completed') await delay(50);
    report.runSucceeded = storage.runs.get({ appId:app.id,id:run.id }).state === 'succeeded';
    const artifacts = storage.artifacts.list(scope).filter(f => f.runId === run.id);
    for (const artifact of artifacts) {
      const reply = ok(await files.request({ operation:'request',owner,request:{ operation:'artifacts.preview',...scope,artifactId:artifact.id } })).reply;
      if (reply.file.status === 'ready' && reply.preview.kind === 'text' && reply.preview.text.trim() === marker) report.artifactMatched = true;
    }
    if (report.attachmentCopied && report.runSucceeded && report.artifactMatched) { report.gate = 'PASS'; report.code = 'SUCCESS'; }
    else { report.gate = 'FAIL'; report.code = 'LIVE_FILE_FLOW_INCOMPLETE'; process.exitCode = 1; }
  }
} catch (error) {
  report.code = ['TEST_DATA_HAS_ACTIVE_RUNS','TEST_APP_NOT_PUBLISHED','TEST_REQUIRES_CONTROLLED_WRITE_APP','CREDENTIAL_UNAVAILABLE'].includes(error.message) ? error.message : 'LIVE_FILE_FLOW_UNAVAILABLE';
  process.exitCode = 2;
} finally {
  await scheduler?.close(); policy?.close(); files?.close(); storage?.close();
  // No keys, endpoints, marker, model response, original file path, or session paths in evidence.
  writeFileSync(resolve('docs/technical/evidence/file-live-validation.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
