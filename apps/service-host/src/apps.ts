import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError, id, newAppConfig, timestamp, type App, type AppConfig, type AppId } from '@aiappnest/domain';
import { appRequestSchema, appReplySchema, snapshotSchema, providerConfigSchema, publicError,
  type AppRequest, type AppReply, type AppView, type AppIssue, type AppSnapshot, type AppRevisionView, type Result, type ErrorCode } from '@aiappnest/contracts';
import type { Storage } from '@aiappnest/storage';
import type { ProviderService } from './providers';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const runtimeVersion = '0.73.1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type FaultPoint = 'write' | 'renamed' | 'transaction';

export class AppService {
  constructor(private readonly storage: Storage, private readonly providers: ProviderService,
    // Trusted test injection only; never reachable through IPC.
    private readonly fault: (point: FaultPoint) => void = () => {}) { this.collectSnapshots(); }

  private current(appId: string, expectedVersion?: number): App {
    const app = this.storage.apps.get({ id: id<'app'>(appId) });
    if (expectedVersion !== undefined && app.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT');
    return app;
  }
  private removeManagedTree(path: string): void {
    this.storage.paths.assertManaged(path);
    if (!existsSync(path)) return;
    // Refuse linked descendants as well as linked ancestors before recursive deletion.
    const inspect = (directory: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, item.name); this.storage.paths.assertManaged(child);
        if (item.isDirectory()) inspect(child);
      }
    };
    inspect(path); rmSync(path, { recursive: true, force: true });
  }
  /** Runs under the SQLite writer lock, so another service cannot collect an in-flight publish. */
  collectSnapshots(): void {
    this.storage.transaction(() => {
      const root = join(this.storage.paths.root, 'apps');
      this.storage.paths.assertManaged(root);
      for (const app of readdirSync(root, { withFileTypes: true })) {
        if (!app.isDirectory() || !uuidPattern.test(app.name)) continue;
        const revisions = join(root, app.name, 'revisions');
        this.storage.paths.assertManaged(revisions);
        if (!existsSync(revisions)) continue;
        for (const entry of readdirSync(revisions, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const staging = entry.name.startsWith('.staging-') && uuidPattern.test(entry.name.slice(9));
          if (!staging && !uuidPattern.test(entry.name)) continue;
          if (!staging) {
            try { this.storage.revisions.get({ appId: id<'app'>(app.name), id: id<'revision'>(entry.name) }); continue; }
            catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; }
          }
          this.removeManagedTree(join(revisions, entry.name));
        }
      }
    });
  }
  private issues(config: AppConfig, frozen?: AppSnapshot): AppIssue[] {
    const issues: AppIssue[] = [];
    if (!config.role.trim()) issues.push('ROLE_REQUIRED');
    if ((config.permissions.mode === 'chat' && config.permissions.tools.length > 0)
      || (config.permissions.mode !== 'trusted-automation' && config.permissions.tools.includes('shell'))) issues.push('PERMISSION_CONFLICT');
    // SkillRegistry import/dependency validation is not integrated yet. Fail closed even for legacy registry rows.
    if (config.skills.length) issues.push('SKILL_UNRESOLVED');
    if (!config.model) issues.push('MODEL_REQUIRED');
    else {
      let profile;
      try { profile = this.storage.providers.get({ id: id<'provider'>(config.model.providerProfileId) }); }
      catch (error) { if (!(error instanceof DomainError) || error.code !== 'NOT_FOUND') throw error; issues.push('PROVIDER_MISSING'); return issues; }
      if (!frozen && profile.revision !== config.model.expectedRevision) issues.push('PROVIDER_CHANGED');
      const parsed = providerConfigSchema.safeParse(frozen?.provider ?? { name: profile.name, providerType: profile.providerType,
        endpoint: profile.endpoint, modelId: profile.modelId, authMode: profile.authMode, settings: profile.settings });
      if (!parsed.success) issues.push('MODEL_INVALID');
      else {
        try { this.providers.snapshotRuntime(profile.id, parsed.data); }
        catch { issues.push('CREDENTIAL_UNAVAILABLE'); }
      }
    }
    return issues;
  }
  private view(app: App): AppView {
    const draft = this.storage.appDraft(app.id);
    const draftIssues = this.issues(draft.config);
    let reasons: AppIssue[];
    if (app.currentRevisionId) {
      try { const revision = this.readRevision(app.id, app.currentRevisionId); reasons = this.issues(revision.snapshot.config, revision.snapshot); }
      catch { reasons = ['SNAPSHOT_UNAVAILABLE']; }
    } else reasons = [...draftIssues, 'NOT_PUBLISHED'];
    const missing = reasons.some(reason => ['PROVIDER_MISSING', 'CREDENTIAL_UNAVAILABLE', 'SKILL_UNRESOLVED', 'SNAPSHOT_UNAVAILABLE'].includes(reason));
    return { id: app.id, name: app.name, description: app.description,
      icon: ['spark','code','book','pen'].includes(app.icon ?? '') ? app.icon as AppView['icon'] : 'spark',
      version: app.version, currentRevisionId: app.currentRevisionId, createdAt: app.createdAt, updatedAt: app.updatedAt,
      category: draft.category, favorite: draft.favorite, lastOpenedAt: draft.lastOpenedAt,
      archived: app.status === 'archived', state: app.status === 'archived' ? 'archived' : missing ? 'missing-dependencies' : reasons.length ? 'incomplete' : 'usable',
      reasons, draft: draft.config, draftIssues, trialStatus: 'not-tested' };
  }
  readRevision(appId: string, revisionId: string): AppRevisionView {
    const app = id<'app'>(appId), rev = id<'revision'>(revisionId);
    const revision = this.storage.revisions.get({ appId: app, id: rev });
    const stored = this.storage.snapshot(app, rev);
    const snapshot = snapshotSchema.parse(JSON.parse(stored.snapshot));
    if (snapshot.appId !== app || snapshot.revisionId !== rev || hash(stored.snapshot) !== stored.configHash) throw new DomainError('STORAGE_UNAVAILABLE');
    const root = this.storage.paths.revision(app, rev);
    const read = (name: string) => { const file = join(root, name); this.storage.paths.assertManaged(file); return readFileSync(file, 'utf8'); };
    if (read('manifest.json') !== stored.snapshot) throw new DomainError('STORAGE_UNAVAILABLE');
    for (const resource of snapshot.resources) if (hash(read(resource.path)) !== resource.hash) throw new DomainError('STORAGE_UNAVAILABLE');
    return { id: revision.id, appId: app, revision: revision.revision, createdAt: revision.createdAt, configHash: stored.configHash, snapshot };
  }
  private publish(app: App): void {
    if (app.status === 'archived') throw new DomainError('INVALID_TRANSITION');
    const config = this.storage.appDraft(app.id).config;
    if (this.issues(config).length) throw new DomainError('INVALID_INPUT');
    const profile = this.storage.providers.get({ id: id<'provider'>(config.model!.providerProfileId) });
    const provider = providerConfigSchema.parse({ name: profile.name, providerType: profile.providerType, endpoint: profile.endpoint,
      modelId: profile.modelId, authMode: profile.authMode, settings: profile.settings });
    const revisionId = id<'revision'>(randomUUID());
    const directory = this.storage.paths.revision(app.id, revisionId);
    const staging = join(dirname(directory), `.staging-${revisionId}`);
    const roleText = `${config.role}\n\n## Output requirements\n${config.outputRequirements}\n`;
    const configText = JSON.stringify({ config, provider, protocol: 'openai-completions', runtimeVersion });
    const snapshot: AppSnapshot = { schemaVersion: 1, appId: app.id, revisionId, config, provider, credentialBinding: profile.id,
      protocol: 'openai-completions', runtimeVersion, roleText, validation: null,
      resources: [{ path: 'config.json', hash: hash(configText) }, { path: 'role.md', hash: hash(roleText) }] };
    const manifest = JSON.stringify(snapshot);
    try {
      this.storage.paths.ensureDirectory(staging);
      const write = (name: string, content: string) => { const file = join(staging, name); this.storage.paths.assertManaged(file); writeFileSync(file, content, { encoding: 'utf8', flag: 'wx', flush: true }); };
      write('config.json', configText); this.fault('write');
      write('role.md', roleText); write('manifest.json', manifest);
      this.storage.paths.assertManaged(directory); renameSync(staging, directory); this.fault('renamed');
      this.storage.publishRevision({ id: revisionId, appId: app.id, revision: this.storage.nextRevision(app.id), providerProfileId: profile.id,
        config, roleText, runtimeVersion, createdAt: timestamp() }, [], app.version);
      this.storage.saveSnapshot(app.id, revisionId, hash(manifest), manifest);
      this.fault('transaction');
      // Re-read the complete files before the outer transaction can commit currentRevisionId.
      this.readRevision(app.id, revisionId);
    } catch (error) {
      // DB rollback is handled by request's outer transaction. Cleanup failure is retryable at startup.
      for (const path of [staging, directory]) try { this.removeManagedTree(path); } catch { /* startup collection */ }
      throw error;
    }
  }
  private dispatch(request: AppRequest): AppReply {
    if (request.operation === 'list') {
      const result = this.storage.listApps(request.query, request.archived, request.sort, request.limit, request.offset);
      return { operation: 'list', total: result.total, apps: result.apps.map(app => this.view(app)) };
    }
    if (request.operation === 'revision') return { operation: 'revision', revision: this.readRevision(request.appId, request.revisionId) };
    if (request.operation === 'create') {
      const now = timestamp();
      const app = this.storage.apps.insert({ id: id<'app'>(randomUUID()), name: request.metadata.name, description: request.metadata.description,
        icon: request.metadata.icon, status: 'draft', currentRevisionId: null, version: 1, createdAt: now, updatedAt: now });
      this.storage.saveAppDraft(app.id, newAppConfig(), request.metadata.category, request.metadata.favorite);
      return { operation: 'create', app: this.view(app) };
    }
    let app = this.current(request.appId, 'expectedVersion' in request ? request.expectedVersion : undefined);
    if (request.operation === 'activeRuns') return { operation: 'activeRuns', count: this.storage.activeAppRuns(app.id) };
    if (request.operation === 'update') {
      app = this.storage.updateApp(app.id, app.version, { name: request.metadata.name, description: request.metadata.description,
        icon: request.metadata.icon, status: app.status });
      this.storage.saveAppDraft(app.id, request.draft, request.metadata.category, request.metadata.favorite);
    } else if (request.operation === 'publish') { this.publish(app); app = this.current(app.id); }
    else if (request.operation === 'copy') {
      const source = this.storage.appDraft(app.id), now = timestamp();
      // No model reference survives copying, even when the original profile uses no authentication.
      const config: AppConfig = { ...source.config, model: null, skills: source.config.skills.filter(skill => {
        try { return this.storage.skills.get({ id: id<'skill'>(skill.id), version: skill.version }).hash === skill.hash; } catch { return false; }
      }) };
      app = this.storage.apps.insert({ id: id<'app'>(randomUUID()), name: `${app.name.slice(0, 75)} 副本`, description: app.description,
        icon: app.icon, status: 'draft', currentRevisionId: null, version: 1, createdAt: now, updatedAt: now });
      this.storage.saveAppDraft(app.id, config, source.category, false);
    } else if (request.operation === 'archive') {
      if (request.archived && this.storage.activeAppRuns(app.id)) throw new DomainError('INVALID_TRANSITION');
      app = this.storage.updateApp(app.id, app.version, { name: app.name, description: app.description, icon: app.icon,
        status: request.archived ? 'archived' : app.currentRevisionId ? 'ready' : 'draft' });
    } else if (request.operation === 'open') {
      if (app.status === 'archived') throw new DomainError('INVALID_TRANSITION');
      this.storage.touchApp(app.id);
    }
    return { operation: request.operation, app: this.view(app) };
  }
  request(raw: unknown): Result<AppReply> {
    const parsed = appRequestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT') };
    try { return { ok: true, value: this.storage.transaction(() => appReplySchema.parse(this.dispatch(parsed.data))) }; }
    catch (error) {
      let code: ErrorCode = 'STORAGE_UNAVAILABLE';
      if (error instanceof DomainError) {
        if (['INVALID_INPUT','NOT_FOUND','VERSION_CONFLICT'].includes(error.code)) code = error.code as ErrorCode;
        else if (error.code === 'INVALID_TRANSITION') code = 'APP_UNAVAILABLE';
      }
      return { ok: false, error: publicError(code) };
    }
  }
}
