// Shared by the CLI and deterministic tests. No transport or credential bypass.
export async function runLiveGate(service, cloud, local) {
  if (!['openai', 'deepseek'].includes(cloud.providerType) || cloud.authMode !== 'api-key' || local.providerType !== 'local-openai') throw new Error('UNSUPPORTED_PROFILES');
  const report = {};
  let unavailable = false;
  // Validate both exact revisions and resolve both credentials before either call.
  for (const [name, profile] of [['cloud', cloud], ['local', local]]) {
    report[name] = { providerType: profile.providerType, modelId: profile.modelId, revision: profile.revision,
      mode: 'non-thinking-text-sse', code: 'NOT_TESTED' };
    try { service.runtime({ id: profile.id, revision: profile.revision }); }
    catch (error) {
      unavailable = true;
      report[name].code = ['CREDENTIAL_UNAVAILABLE', 'VERSION_CONFLICT', 'INVALID_INPUT', 'NOT_FOUND'].includes(error?.code)
        ? error.code : 'PROFILE_OR_CREDENTIAL_UNAVAILABLE';
    }
  }
  if (unavailable) return { ...report, gate: 'BLOCKED', code: 'PROFILE_OR_CREDENTIAL_UNAVAILABLE' };
  for (const [name, profile] of [['cloud', cloud], ['local', local]]) {
    const result = await service.request({ operation: 'test', input: { id: profile.id, revision: profile.revision } });
    report[name] = { ...report[name], ...(result.ok ? { ...result.value.result, id: undefined } : { code: result.error.code }) };
  }
  report.gate = report.cloud.code === 'SUCCESS' && report.local.code === 'SUCCESS' && !report.cloud.stale && !report.local.stale ? 'PASS' : 'BLOCKED';
  report.code = report.gate === 'PASS' ? 'REAL_MODEL_TEXT_GENERATION_VERIFIED' : 'MODEL_TEST_FAILED';
  return report;
}
