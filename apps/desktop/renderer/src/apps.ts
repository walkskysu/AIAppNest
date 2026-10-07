import { defineComponent, h, onMounted, reactive, ref, watch } from 'vue';
import { ChatWorkspace } from './chat';
import { ProviderSettings } from './providers';
import { SkillLibrary } from './skills';
import type { TrialView } from '@aiappnest/contracts';
import { newAppConfig, appConfigSchema, appMetadataSchema, trustedBoundaryNotice, type AppView, type AppIssue, type AppRequest, type AppReply, type ProviderView, type SkillView } from '@aiappnest/contracts';

const states = { usable: '可使用（配置就绪）', incomplete: '配置未完成', 'missing-dependencies': '缺少依赖', archived: '已归档' };
const reasons: Record<AppIssue, string> = { MODEL_REQUIRED: '请重新选择并确认模型关联', PROVIDER_MISSING: '模型配置不存在',
  PROVIDER_CHANGED: '模型配置已变化，请重新选择确认', MODEL_INVALID: '模型设置无效', CREDENTIAL_UNAVAILABLE: '模型凭据缺失、不可读取或端点已变化',
  SKILL_UNRESOLVED: 'Skill 绑定缺失、完整性异常、名称冲突或缺少依赖', PERMISSION_CONFLICT: '工具需求与权限模式冲突', ROLE_REQUIRED: '请填写角色说明',
  SNAPSHOT_UNAVAILABLE: '版本快照缺失或损坏', NOT_PUBLISHED: '尚未发布配置版本' };
const icons = { spark: '✦', code: '⌘', book: '▤', pen: '✎' };
const metadata = (app?: AppView) => ({ name: app?.name ?? '', description: app?.description ?? '',
  icon: app?.icon ?? 'spark' as AppView['icon'], category: app?.category ?? '', favorite: app?.favorite ?? false });
export const ApplicationHome = defineComponent({
  props: { ready: Boolean },
  setup(props) {
    const apps = ref<AppView[]>([]), total = ref(0), offset = ref(0), query = ref(''), archived = ref(false), sort = ref<'recent'|'favorite'|'name'>('recent');
    const selected = ref<AppView>(), editing = ref(false), space = ref<AppView>();
    const trials = ref<TrialView[]>([]), trialText = ref(''), trialSpace = ref<string>(), step = ref(0), showModels = ref(false), showSkills = ref(false);
    const steps = ['基本资料','工作方式','模型与连接','Skill','权限','记忆与执行','试运行与发布'];
    let trialRequestId: string | undefined;
    const loadTrials = async () => {
      if (!selected.value) return;
      const result = await window.desktop.chat({ operation:'trial.list',appId:selected.value.id });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.operation === 'trial.list') trials.value = result.value.trials;
    };
    const form = reactive(metadata()), draft = ref(newAppConfig()), profiles = ref<ProviderView[]>([]);
    const busy = ref(false), feedback = ref(''), dirty = ref(false);
    const skillOptions = ref<SkillView[]>([]), skillOffset = ref(0), skillTotal = ref(0);
    const loadSkills = async () => {
      const result = await window.desktop.skills({ operation:'list',limit:100,offset:skillOffset.value });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.operation === 'list') { skillOptions.value = result.value.skills; skillTotal.value = result.value.total; }
    };
    const call = async (request: AppRequest): Promise<AppReply> => {
      const result = await window.desktop.apps(request);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const list = async () => {
      const result = await call({ operation: 'list', query: query.value, archived: archived.value, sort: sort.value, offset: offset.value, limit: 12 });
      if (result.operation === 'list') { apps.value = result.apps; total.value = result.total; }
    };
    const action = async (fn: () => Promise<void>) => {
      if (busy.value) return;
      busy.value = true; feedback.value = '';
      try { await fn(); } catch (error) { feedback.value = error instanceof Error ? error.message : '操作失败，请重新加载确认。'; }
      finally { busy.value = false; }
    };
    const choose = async (app?: AppView) => {
      if (app) { const result = await call({ operation: 'get', appId: app.id }); if ('app' in result) app = result.app; }
      trials.value = []; trialSpace.value = undefined; trialRequestId = undefined; step.value = 0;
      selected.value = app; Object.assign(form, metadata(app));
      draft.value = app ? JSON.parse(JSON.stringify(app.draft)) : newAppConfig();
      editing.value = true; space.value = undefined; dirty.value = false;
      const result = await window.desktop.providers({ operation: 'list' });
      if (result.ok && result.value.operation === 'list') profiles.value = result.value.profiles;
      else if (!result.ok) throw new Error(result.error.message);
      skillOffset.value = 0; await loadSkills(); await loadTrials();
    };
    const save = async () => {
      const errors = [appMetadataSchema.safeParse(form),appConfigSchema.safeParse(draft.value)]
        .flatMap(result => result.success ? [] : result.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`));
      if (errors.length) throw new Error(`请修改字段：${errors.join('；')}`);
      let app = selected.value;
      if (!app) {
        const created = await call({ operation: 'create', metadata: { ...form } });
        if (!('app' in created)) return;
        app = created.app; selected.value = app;
      }
      const result = await call({ operation: 'update', appId: app.id, expectedVersion: app.version, metadata: { ...form }, draft: JSON.parse(JSON.stringify(draft.value)) });
      if ('app' in result) { selected.value = result.app; dirty.value = false; }
      feedback.value = '草稿已保存。请提交一条测试任务，成功后发布相同配置。'; await list(); await loadTrials();
    };
    const change = () => { dirty.value = true; trialRequestId = undefined; };
    const text = (label: string, value: string, set: (v: string) => void, multiline = false) => h('label', [label,
      h(multiline ? 'textarea' : 'input', { 'aria-label': label, value, onInput: (e: Event) => { set((e.target as HTMLInputElement).value); change(); } })]);
    const number = (label: string, value: number, set: (v: number) => void, min: number, max: number, step = 1) => h('label', [label,
      h('input', { 'aria-label': label, type: 'number', min, max, step, value, onInput: (e: Event) => { set(Number((e.target as HTMLInputElement).value)); change(); } })]);
    const check = (label: string, value: boolean, set: (v: boolean) => void) => h('label', { class: 'check' }, [
      h('input', { type: 'checkbox', checked: value, onChange: (e: Event) => { set((e.target as HTMLInputElement).checked); change(); } }), label]);
    const button = (label: string, fn: () => Promise<void>, disabled = false) => h('button', { type: 'button', class: 'secondary', disabled: busy.value || !props.ready || disabled, onClick: () => action(fn) }, label);
    const refresh = () => action(async () => { offset.value = 0; await list(); });
    onMounted(() => { if (props.ready) void refresh(); });
    watch(() => props.ready, ready => { if (ready) void refresh(); });
    return () => h('section', { class: 'app-home' }, [
      h('div', { class: 'actions' }, [h('h1', '我的应用'), button('创建应用', () => choose()), button('刷新应用列表', list)]),
      h('p', '配置就绪表示已发布且依赖完整；连接测试、试运行与聊天执行需分别验证。打开应用不会启动任务。'),
      h('p', { role: 'status', 'data-testid': 'app-feedback' }, feedback.value),
      space.value ? h(ChatWorkspace,{ key:space.value.id,app:space.value,ready:props.ready,onBack:() => { space.value = undefined; },onSettings:() => action(() => choose(space.value)) }) : null,
      editing.value ? h('section', { class: 'card' }, [h('h2', selected.value ? '编辑应用' : '创建应用'),
        h('nav',{ 'aria-label':'创建步骤',class:'wizard-steps' },steps.map((name,i) => button(`${i+1}. ${name}`,async () => { step.value = i; document.getElementById(`wizard-${i}`)?.scrollIntoView({ block:'start' }); }))),
        h('p',`步骤 ${step.value+1}/7：${steps[step.value]}。可随时保存草稿或返回修改。`),
        button('上一步',async () => { step.value--; document.getElementById(`wizard-${step.value}`)?.scrollIntoView(); },step.value === 0),
        button('下一步',async () => { step.value++; document.getElementById(`wizard-${step.value}`)?.scrollIntoView(); },step.value === 6),
        h('form', { onSubmit: (e: Event) => { e.preventDefault(); void action(save); } }, [
          h('fieldset', { disabled: busy.value || !props.ready }, [
            h('h3',{ id:'wizard-0' },'1. 基本资料'),
            text('应用名称', form.name, v => { form.name = v; }), text('应用简介', form.description, v => { form.description = v; }, true),
            text('分类', form.category, v => { form.category = v; }),
            h('label', ['图标', h('select', { 'aria-label': '图标', value: form.icon, onChange: (e: Event) => { form.icon = (e.target as HTMLSelectElement).value as AppView['icon']; change(); } },
              Object.entries(icons).map(([value, icon]) => h('option', { value }, icon)))]),
            check('收藏应用', form.favorite, v => { form.favorite = v; }),
            h('h3',{ id:'wizard-1' },'2. 工作方式'),
            text('角色说明', draft.value.role, v => { draft.value.role = v; }, true),
            text('输出要求', draft.value.outputRequirements, v => { draft.value.outputRequirements = v; }, true),
            text('开场白', draft.value.openingMessage, v => { draft.value.openingMessage = v; }, true),
            h('h3',{ id:'wizard-2' },'3. 模型与连接'),
            button('配置模型和凭据',async () => { showModels.value = !showModels.value; }),
            h('label', ['应用模型', h('select', { 'aria-label': '应用模型', value: draft.value.model ? `${draft.value.model.providerProfileId}:${draft.value.model.expectedRevision}` : '',
              onChange: (e: Event) => { const selected = profiles.value.find(p => `${p.id}:${p.revision}` === (e.target as HTMLSelectElement).value);
                draft.value.model = selected ? { providerProfileId: selected.id, expectedRevision: selected.revision, temperature: 0.7, maxOutputTokens: 2048 } : null; change(); } },
              [h('option', { value: '' }, '请选择并确认模型关联'), ...profiles.value.map(p => h('option', { value: `${p.id}:${p.revision}` }, `${p.name} · ${p.modelId} · v${p.revision}`))])]),
            button('刷新模型选项', async () => { const result = await window.desktop.providers({ operation: 'list' }); if (result.ok && result.value.operation === 'list') profiles.value = result.value.profiles; }),
            button('测试所选模型连接',async () => {
              const model = draft.value.model!;
              const result = await window.desktop.providers({ operation:'test',input:{ id:model.providerProfileId,revision:model.expectedRevision } });
              if (!result.ok) throw new Error(result.error.message);
              if (result.value.operation === 'test') feedback.value = `连接测试：${result.value.result.code}${result.value.result.stale ? '（已失效）' : ''}。连接测试不等于应用试运行。`;
            },!draft.value.model),
            h('p', '可在此配置模型和凭据，保存后刷新模型选项。只有显式点击才发起连接测试。'),
            draft.value.model ? h('div', { class: 'form-grid' }, [number('温度', draft.value.model.temperature, v => { draft.value.model!.temperature = v; }, 0, 2, 0.1),
              number('最大输出 token', draft.value.model.maxOutputTokens, v => { draft.value.model!.maxOutputTokens = v; }, 1, 32768)]) : null,
            h('h3',{ id:'wizard-3' },'4. Skill 版本绑定'),
            button('管理或导入 Skill',async () => { showSkills.value = !showSkills.value; }),
            h('label',['选择 Skill 版本',h('select',{ 'aria-label':'选择 Skill 版本',value:'',onChange:(e: Event) => {
              const skill = skillOptions.value.find(s => `${s.id}:${s.version}` === (e.target as HTMLSelectElement).value);
              if (skill) { draft.value.skills = [...draft.value.skills.filter(s => s.id !== skill.id),{ id:skill.id,version:skill.version,hash:skill.sha256,enabled:true,invocationMode:'automatic' }]; change(); }
            } },[h('option',{ value:'' },'从技能库添加确定版本'),...skillOptions.value.map(s => h('option',{ value:`${s.id}:${s.version}` },`${s.name} · ${s.version} · ${s.id} · ${s.source}`))])]),
            button('刷新 Skill 选项',loadSkills),
            button('上一页 Skill 选项',async () => { skillOffset.value -= 100; await loadSkills(); },skillOffset.value === 0),
            button('下一页 Skill 选项',async () => { skillOffset.value += 100; await loadSkills(); },skillOffset.value + 100 >= skillTotal.value),
            ...draft.value.skills.map(binding => h('div',[
              h('p',`${binding.id} · ${binding.version} · ${binding.hash}`),
              check(`启用 ${binding.id}`,binding.enabled,v => { binding.enabled = v; }),
              h('label',['调用模式',h('select',{ 'aria-label':`调用模式 ${binding.id}`,value:binding.invocationMode,onChange:(e: Event) => { binding.invocationMode = (e.target as HTMLSelectElement).value as 'explicit'|'automatic'; change(); } },[
                h('option',{ value:'automatic' },'自动匹配'),h('option',{ value:'explicit' },'显式调用'),
              ])]), button('移除绑定',async () => { draft.value.skills = draft.value.skills.filter(s => s.id !== binding.id); change(); }),
            ])),
            draft.value.skills.length ? button('清除 Skill 绑定', async () => { draft.value.skills = []; change(); }) : null,
            h('h3',{ id:'wizard-4' },'5. 文件与工具权限'),
            h('label', ['权限模式', h('select', { 'aria-label': '权限模式', value: draft.value.permissions.mode, onChange: (e: Event) => {
              draft.value.permissions.mode = (e.target as HTMLSelectElement).value as typeof draft.value.permissions.mode; change();
            } }, [h('option', { value: 'chat' }, '仅对话'), h('option', { value: 'controlled-files' }, '受控文件处理'), h('option', { value: 'trusted-automation' }, '可信自动化')])]),
            ...(['read','write','shell'] as const).map(tool => check({ read: '读取文件', write: '写入文件', shell: '运行命令' }[tool], draft.value.permissions.tools.includes(tool), enabled => {
              draft.value.permissions.tools = enabled ? [...draft.value.permissions.tools, tool] : draft.value.permissions.tools.filter(t => t !== tool);
            })),
            draft.value.permissions.mode === 'trusted-automation' ? h('p', { role: 'note', 'data-testid': 'trusted-boundary' }, trustedBoundaryNotice) : null,
            h('p', '发布版本固定权限上限。外部目录需系统选择授权；会话运行仍需独立授权，复制不会继承授权。'),
            h('h3',{ id:'wizard-5' },'6. 记忆与执行'),
            h('p','记忆管理和注入尚未接入；以下仅保存未来使用的配置，不代表当前可用。'),
            check('启用应用记忆', draft.value.memory.enabled, v => { draft.value.memory.enabled = v; }),
            check('自动提取候选（仍需审核）', draft.value.memory.automaticCandidates, v => { draft.value.memory.automaticCandidates = v; }),
            h('div', { class: 'form-grid' }, [number('记忆条数', draft.value.memory.maxItems, v => { draft.value.memory.maxItems = v; }, 0, 100),
              number('记忆 token 预算', draft.value.memory.tokenBudget, v => { draft.value.memory.tokenBudget = v; }, 0, 32000),
              number('最多执行轮数', draft.value.execution.maxTurns, v => { draft.value.execution.maxTurns = v; }, 1, 100),
              number('执行超时（毫秒）', draft.value.execution.timeoutMs, v => { draft.value.execution.timeoutMs = v; }, 1000, 3600000)]),
            h('h3',{ id:'wizard-6' },'7. 隔离试运行与发布'),
            h('p','只运行你明确提交的任务。测试使用独立会话和目录，不注入正式记忆。关闭向导不会取消任务；请在测试工作空间点击停止。诊断与文件保留，移入回收区后由数据管理清理。'),
            h('label',['测试任务',h('textarea',{ 'aria-label':'测试任务',value:trialText.value,onInput:(e:Event) => { trialText.value = (e.target as HTMLTextAreaElement).value; trialRequestId = undefined; } })]),
            button('提交隔离试运行',async () => {
              const app = selected.value!; trialRequestId ??= crypto.randomUUID();
              const result = await window.desktop.chat({ operation:'trial.start',appId:app.id,expectedVersion:app.version,trialId:trialRequestId,text:trialText.value });
              if (!result.ok) throw new Error(result.error.message);
              if (result.value.operation === 'trial.start') trialSpace.value = result.value.trial.conversationId;
              trialRequestId = undefined; await loadTrials();
            },!selected.value || dirty.value || !trialText.value.trim() || !!selected.value?.draftIssues.length),
            button('刷新试运行结果',loadTrials,!selected.value),
            ...trials.value.map(trial => h('div',[
              h('p',`测试：${trial.run?.state ?? '尚未提交'} · ${dirty.value || trial.stale ? '配置已修改，结果失效' : trial.published ? '已发布' : '配置一致'}`),
              h('details',[h('summary','测试配置哈希'),h('code',trial.configHash)]),
              button('打开测试工作空间',async () => { trialSpace.value = trial.conversationId; }),
            ])),
            h('div', { class: 'actions' }, [h('button', { type: 'submit' }, '保存应用草稿'),
              button('发布配置版本', async () => {
                const app = selected.value!, trial = trials.value.find(t => !t.stale && t.run?.state === 'succeeded')!;
                const result = await window.desktop.chat({ operation:'trial.publish',appId:app.id,trialId:trial.id,expectedVersion:app.version });
                if (!result.ok) throw new Error(result.error.message);
                if (result.value.operation === 'trial.publish') selected.value = result.value.app;
                feedback.value = '已发布测试过的完全相同配置。'; await loadTrials(); await list();
              }, !selected.value || dirty.value || !trials.value.some(t => !t.stale && t.run?.state === 'succeeded')),
              button('重新加载应用', () => choose(selected.value), !selected.value),
              button('关闭编辑', async () => { editing.value = false; })]),
          ]),
        ]),
        selected.value ? h('div', [h('p', `草稿版本 ${selected.value.version} · ${states[selected.value.state]}`),
          h('ul', selected.value.draftIssues.map(reason => h('li', reasons[reason]))),
          dirty.value ? h('p', '有未保存修改；请先保存草稿。') : null]) : null,
      ]) : null,
      editing.value && showModels.value ? h(ProviderSettings,{ ready:props.ready }) : null,
      editing.value && showSkills.value ? h(SkillLibrary,{ ready:props.ready }) : null,
      editing.value && selected.value && trialSpace.value ? h(ChatWorkspace,{ key:trialSpace.value,app:selected.value,ready:props.ready,trialConversation:trialSpace.value,onBack:() => { trialSpace.value = undefined; void action(loadTrials); },onSettings:() => { trialSpace.value = undefined; } }) : null,
      h('form', { class: 'app-filters', onSubmit: (e: Event) => { e.preventDefault(); void refresh(); } }, [
        h('input', { 'aria-label': '搜索应用', placeholder: '搜索名称、简介、分类', value: query.value, onInput: (e: Event) => { query.value = (e.target as HTMLInputElement).value; } }),
        h('button', { type: 'submit', disabled: busy.value || !props.ready }, '搜索'),
        h('select', { 'aria-label': '应用排序', value: sort.value, onChange: (e: Event) => { sort.value = (e.target as HTMLSelectElement).value as typeof sort.value; void refresh(); } },
          [h('option', { value: 'recent' }, '最近使用'), h('option', { value: 'favorite' }, '收藏优先'), h('option', { value: 'name' }, '名称')]),
        h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: archived.value, onChange: (e: Event) => { archived.value = (e.target as HTMLInputElement).checked; void refresh(); } }), '查看已归档']),
      ]),
      h('div', { class: 'app-grid' }, apps.value.map(app => h('article', { class: 'card app-card', key: app.id, 'data-testid': 'app-card' }, [
        h('h2', `${icons[app.icon]} ${app.name}`), h('p', app.description || '暂无简介'), h('p', app.category || '未分类'),
        h('strong', states[app.state]), h('ul', app.reasons.map(reason => h('li', reasons[reason]))),
        h('p', app.lastOpenedAt ? `最近使用 ${new Date(app.lastOpenedAt).toLocaleString()}` : '尚未打开'),
        h('div', { class: 'actions' }, [button('打开应用', async () => { const result = await call({ operation: 'open', appId: app.id }); if ('app' in result) { space.value = result.app; editing.value = false; } await list(); }, app.archived),
          button('编辑', () => choose(app)), button(app.favorite ? '取消收藏' : '收藏', async () => {
            await call({ operation: 'update', appId: app.id, expectedVersion: app.version, metadata: { ...metadata(app), favorite: !app.favorite }, draft: app.draft }); await list();
          }), button('复制', async () => { const result = await call({ operation: 'copy', appId: app.id, expectedVersion: app.version }); if ('app' in result) await choose(result.app);
            feedback.value = '已复制非敏感配置；模型关联和外部目录授权需重新配置，历史未复制。'; await list(); }),
          button(app.archived ? '恢复' : '归档', async () => { await call({ operation: 'archive', appId: app.id, expectedVersion: app.version, archived: !app.archived }); await list(); }),
        ]),
      ]))),
      h('div', { class: 'actions' }, [h('p', `共 ${total.value} 个应用`), button('上一页', async () => { offset.value = Math.max(0, offset.value - 12); await list(); }, offset.value === 0),
        button('下一页', async () => { offset.value += 12; await list(); }, offset.value + 12 >= total.value)]),
    ]);
  },
});
