import { defineComponent, h, onMounted, onUnmounted, reactive, ref, computed } from 'vue';
import type { ProviderConfig, ProviderSave, ProviderView, ProviderTest, ProbeCode } from '@aiappnest/contracts';

const defaults = (): ProviderConfig => ({ name: '', providerType: 'openai', endpoint: 'https://api.openai.com/v1',
  modelId: '', authMode: 'api-key', settings: { timeoutMs: 15000 } });
const outcomes: Record<ProbeCode, string> = {
  SUCCESS: '连接成功：模型已完成短文本生成。', AUTH_FAILED: '认证失败，请检查或替换 API Key。',
  MODEL_NOT_FOUND: '模型或接口不存在，请核对模型 ID。', RATE_LIMITED: '请求受限，请稍后手动重试。',
  NETWORK_ERROR: '网络或服务不可用，请检查端点。', PROTOCOL_ERROR: '响应不符合支持的文本流协议。',
  TIMEOUT: '连接测试超时。', CREDENTIAL_UNAVAILABLE: '凭据不可读取，请重新输入。',
};
export const ProviderSettings = defineComponent({
  props: { ready: Boolean },
  setup(props) {
    const profiles = ref<ProviderView[]>([]);
    const selected = ref<ProviderView>();
    const config = reactive(defaults());
    const key = ref('');
    const busy = ref(false);
    const feedback = ref('');
    const tested = ref<ProviderTest>();
    const savedConfig = ref('');
    const dirty = computed(() => JSON.stringify(config) !== savedConfig.value || key.value !== '');
    const clearKey = () => { key.value = ''; };
    const choose = (profile?: ProviderView) => {
      clearKey(); tested.value = undefined; feedback.value = ''; selected.value = profile;
      Object.assign(config, profile ? { name: profile.name, providerType: profile.providerType, endpoint: profile.endpoint,
        modelId: profile.modelId, authMode: profile.authMode, settings: { ...profile.settings } } : defaults());
      savedConfig.value = profile ? JSON.stringify(config) : '';
    };
    const load = async () => {
      busy.value = true; clearKey();
      try {
        const reply = await window.desktop.providers({ operation: 'list' });
        if (reply.ok && reply.value.operation === 'list') { profiles.value = reply.value.profiles; choose(); }
        else if (!reply.ok) feedback.value = reply.error.message;
      } catch { feedback.value = '无法读取配置，请重试。'; }
      finally { busy.value = false; }
    };
    onMounted(() => { window.addEventListener('pagehide', clearKey); void load(); });
    onUnmounted(() => { clearKey(); window.removeEventListener('pagehide', clearKey); });
    const save = async () => {
      const input: ProviderSave = {
        ...(selected.value ? { id: selected.value.id, expectedRevision: selected.value.revision } : {}),
        config: JSON.parse(JSON.stringify(config)),
        credential: config.authMode === 'none' ? { action: 'clear' } : key.value ? { action: 'replace', key: key.value } : { action: 'keep' },
      };
      clearKey(); busy.value = true; tested.value = undefined;
      try {
        const reply = await window.desktop.providers({ operation: 'save', input });
        if (reply.ok && reply.value.operation === 'save') {
          const { profile, cleanupPending } = reply.value;
          profiles.value = [...profiles.value.filter(p => p.id !== profile.id), profile]; choose(profile);
          feedback.value = cleanupPending ? '已保存；旧加密凭据清理待重试。' : '已保存。可手动测试连接（可能产生少量费用）。';
        } else if (!reply.ok) feedback.value = reply.error.message;
      } catch { feedback.value = '保存状态未知，请重新加载配置后确认。'; }
      finally { input.credential = { action: 'keep' }; busy.value = false; }
    };
    const test = async () => {
      if (!selected.value || dirty.value) return;
      busy.value = true; feedback.value = '正在发送固定短请求…'; tested.value = undefined;
      try {
        const reply = await window.desktop.providers({ operation: 'test', input: { id: selected.value.id, revision: selected.value.revision } });
        if (reply.ok && reply.value.operation === 'test') { tested.value = reply.value.result; feedback.value = ''; }
        else if (!reply.ok) feedback.value = reply.error.message;
      } catch { feedback.value = '测试中断，请手动重试。'; }
      finally { busy.value = false; }
    };
    const remove = async () => {
      if (!selected.value) return;
      busy.value = true; clearKey();
      try {
        const reply = await window.desktop.providers({ operation: 'delete', input: { id: selected.value.id, revision: selected.value.revision } });
        if (reply.ok && reply.value.operation === 'delete') {
          profiles.value = profiles.value.filter(p => p.id !== selected.value!.id); choose();
          feedback.value = reply.value.cleanupPending ? '已删除配置；加密凭据清理待重试。' : '已删除配置和凭据。';
        } else if (!reply.ok) feedback.value = reply.error.message;
      } catch { feedback.value = '删除状态未知，请重新加载后确认。'; }
      finally { busy.value = false; }
    };
    const field = (label: string, name: 'name' | 'endpoint' | 'modelId') => h('label', [label,
      h('input', { 'aria-label': label, value: config[name], onInput: (e: Event) => { config[name] = (e.target as HTMLInputElement).value; }, autocomplete: 'off', spellcheck: false }),
    ]);
    return () => h('section', { class: 'card provider-settings' }, [
      h('h2', '模型设置'),
      h('p', '支持 OpenAI 官方文本模型及本机 OpenAI 兼容文本接口；其他兼容服务未认证。模型 ID 手动输入。'),
      h('fieldset', { disabled: busy.value || !props.ready }, [
        h('div', { class: 'actions' }, [h('button', { class: 'secondary', onClick: () => choose() }, '新增模型'), h('button', { class: 'secondary', onClick: load }, '重新加载')]),
        h('ul', { class: 'provider-list' }, profiles.value.map(p => h('li', { key: p.id }, h('button', { class: 'secondary', onClick: () => choose(p) }, `${p.name} · ${p.modelId || '待配置'} · v${p.revision}`)))),
        h('form', { novalidate: true, onSubmit: (e: Event) => { e.preventDefault(); void save(); } }, [
          field('显示名称', 'name'),
          h('label', ['协议', h('select', { 'aria-label': '协议', value: config.providerType, onChange: (e: Event) => {
            config.providerType = (e.target as HTMLSelectElement).value as ProviderConfig['providerType'];
            config.endpoint = config.providerType === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:11434/v1';
            config.authMode = config.providerType === 'openai' ? 'api-key' : 'none'; clearKey();
          } }, [h('option', { value: 'openai' }, 'OpenAI 官方'), h('option', { value: 'local-openai' }, '本地 OpenAI 兼容（预览）')])]),
          field('端点', 'endpoint'), field('模型 ID', 'modelId'),
          h('label', ['认证方式', h('select', { 'aria-label': '认证方式', value: config.authMode, onChange: (e: Event) => { config.authMode = (e.target as HTMLSelectElement).value as ProviderConfig['authMode']; clearKey(); } }, [
            h('option', { value: 'api-key' }, 'API Key'), h('option', { value: 'none', disabled: config.providerType === 'openai' }, '无需认证'),
          ])]),
          config.authMode === 'api-key' ? h('label', ['API Key', h('input', { 'aria-label': 'API Key', type: 'password', value: key.value,
            autocomplete: 'new-password', spellcheck: false, placeholder: selected.value?.hasCredential ? '已保存；留空保留原凭据' : '输入 API Key',
            onInput: (e: Event) => { key.value = (e.target as HTMLInputElement).value; } })]) : null,
          h('label', ['超时（毫秒）', h('input', { 'aria-label': '超时（毫秒）', type: 'number', min: 100, max: 60000, value: config.settings.timeoutMs,
            onInput: (e: Event) => { config.settings.timeoutMs = Number((e.target as HTMLInputElement).value); } })]),
          h('p', 'Key 在提交或离开设置后清空；更换端点时需重新输入 Key。'),
          h('div', { class: 'actions' }, [h('button', { type: 'submit' }, '保存模型'),
            h('button', { type: 'button', onClick: test, disabled: !selected.value || dirty.value }, '测试模型连接'),
            h('button', { type: 'button', class: 'secondary', onClick: remove, disabled: !selected.value }, '删除模型')]),
        ]),
      ]),
      dirty.value && selected.value ? h('p', '配置已修改，保存后再测试。') : null,
      h('p', { role: 'status', 'data-testid': 'provider-feedback' }, feedback.value),
      tested.value && !dirty.value ? h('p', { role: 'status', 'data-testid': 'provider-result' }, tested.value.stale
        ? '测试期间配置已变化，结果已失效。请重新加载。'
        : `${outcomes[tested.value.code]}（修订 ${tested.value.revision}，${tested.value.durationMs} ms）`) : null,
    ]);
  },
});
