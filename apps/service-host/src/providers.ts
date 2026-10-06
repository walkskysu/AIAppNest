import { randomUUID } from 'node:crypto';
import { DomainError, id, timestamp, type ProviderProfile } from '@aiappnest/domain';
import { providerConfigSchema, providerRequestSchema, publicError, type ErrorCode, type ProviderRequest, type ProviderReply,
  type ProviderSave, type ProviderIdentity, type ProviderView, type Result } from '@aiappnest/contracts';
import type { Storage } from '@aiappnest/storage';
import { buildRuntime, testRuntime, type ProviderRuntime } from '../../../packages/pi-adapter/src/index';
import { CredentialError, type CredentialStore } from './credentials';

function view(profile: ProviderProfile): ProviderView {
  const { secretRef, ...fields } = profile;
  return { ...fields, hasCredential: secretRef !== null };
}
export class ProviderService {
  private activeTests = 0;
  constructor(private readonly storage: Storage, private readonly credentials: CredentialStore,
    private readonly probe: typeof testRuntime = testRuntime) {
    this.cleanup();
  }
  private cleanup(): boolean {
    try { return this.credentials.collect(this.storage.providerSecretRefs()); } catch { return true; }
  }
  private current(identity: ProviderIdentity): ProviderProfile {
    const profile = this.storage.providers.get({ id: id<'provider'>(identity.id) });
    if (profile.revision !== identity.revision) throw new DomainError('VERSION_CONFLICT');
    return profile;
  }
  /** Resolve a rotated credential only for the frozen endpoint and authentication boundary. */
  snapshotRuntime(providerId: string, frozen: import('@aiappnest/contracts').ProviderConfig): ProviderRuntime {
    const profile = this.storage.providers.get({ id: id<'provider'>(providerId) });
    const config = providerConfigSchema.parse(frozen);
    if (profile.endpoint !== config.endpoint || profile.providerType !== config.providerType || profile.authMode !== config.authMode) throw new CredentialError();
    if (config.authMode === 'api-key' && !profile.secretRef) throw new CredentialError();
    return buildRuntime(config, config.authMode === 'api-key' ? this.credentials.read(profile.secretRef!) : undefined);
  }
  /** Internal entry point for future PiAdapter calls; never exposed over IPC. */
  runtime(identity: ProviderIdentity): ProviderRuntime {
    const profile = this.current(identity);
    const parsed = providerConfigSchema.safeParse({ name: profile.name, providerType: profile.providerType,
      endpoint: profile.endpoint, modelId: profile.modelId, authMode: profile.authMode, settings: profile.settings });
    if (!parsed.success) throw new DomainError('INVALID_INPUT');
    if (profile.authMode === 'api-key' && !profile.secretRef) throw new CredentialError();
    return buildRuntime(parsed.data, profile.authMode === 'api-key' ? this.credentials.read(profile.secretRef!) : undefined);
  }
  private save(input: ProviderSave): ProviderReply {
    const previous = input.id ? this.current({ id: input.id, revision: input.expectedRevision! }) : undefined;
    if (!previous && this.storage.providers.list({}, { limit: 1000 }).length >= 1000) throw new DomainError('INVALID_INPUT');
    const { config, credential } = input;
    if (config.authMode === 'none' && credential.action !== 'clear') throw new DomainError('INVALID_INPUT');
    if (config.authMode === 'api-key' && (credential.action === 'clear' || (credential.action === 'keep' && !previous?.secretRef))) throw new DomainError('INVALID_INPUT');
    if (credential.action === 'keep' && previous && (previous.endpoint !== config.endpoint || previous.providerType !== config.providerType)) throw new DomainError('INVALID_INPUT');
    // Prevent accidentally copying a newly entered key into ordinary metadata.
    if (credential.action === 'replace' && JSON.stringify(config).includes(credential.key)) throw new DomainError('INVALID_INPUT');
    let created: string | undefined;
    try {
      if (credential.action === 'replace') created = this.credentials.create(credential.key);
      const now = timestamp();
      const profile: ProviderProfile = { ...config, id: previous?.id ?? id<'provider'>(randomUUID()),
        secretRef: created ?? (credential.action === 'keep' ? previous!.secretRef : null),
        revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
      const saved = this.storage.saveProvider(profile, input.expectedRevision);
      // Commit first. Old ciphertext is now an orphan and safely retryable if deletion fails.
      created = undefined;
      return { operation: 'save', profile: view(saved), cleanupPending: this.cleanup() };
    } catch (error) {
      if (created) try { this.credentials.remove(created); } catch { /* collect on startup/next mutation */ }
      throw error;
    }
  }
  async request(raw: unknown): Promise<Result<ProviderReply>> {
    const parsed = providerRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    if (parsed.data.operation === 'test' && this.activeTests >= 4) return { ok: false, error: publicError('BUSY') };
    try { return { ok: true, value: await this.dispatch(parsed.data) }; }
    catch (error) {
      let code: ErrorCode = 'STORAGE_UNAVAILABLE';
      if (error instanceof CredentialError) code = 'CREDENTIAL_UNAVAILABLE';
      else if (error instanceof DomainError) {
        if (['INVALID_INPUT', 'VERSION_CONFLICT', 'NOT_FOUND'].includes(error.code)) code = error.code as ErrorCode;
        else if (error.code === 'OWNERSHIP_MISMATCH') code = 'PROVIDER_IN_USE';
      }
      return { ok: false, error: publicError(code) };
    }
  }
  private async dispatch(request: ProviderRequest): Promise<ProviderReply> {
    if (request.operation === 'list') return { operation: 'list', profiles: this.storage.providers.list({}, { limit: 1000 }).map(view) };
    if (request.operation === 'save') return this.save(request.input);
    if (request.operation === 'delete') {
      const profile = this.current(request.input);
      this.storage.deleteProvider(profile.id, profile.revision);
      return { operation: 'delete', cleanupPending: this.cleanup() };
    }
    const start = Date.now();
    const elapsed = performance.now();
    this.current(request.input);
    this.activeTests++;
    try {
      let code;
      try { code = await this.probe(this.runtime(request.input)); }
      catch (error) { if (!(error instanceof CredentialError)) throw error; code = 'CREDENTIAL_UNAVAILABLE' as const; }
      let stale = false;
      try { this.current(request.input); } catch { stale = true; }
      return { operation: 'test', result: { ...request.input, code, testedAt: start, durationMs: Math.round(performance.now() - elapsed), stale } };
    } finally { this.activeTests--; }
  }
}
