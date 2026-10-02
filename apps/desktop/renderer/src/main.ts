import { createApp, defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import type { ServiceStatus } from '@aiappnest/contracts';
import './style.css';

createApp(defineComponent({
  setup() {
    const status = ref<ServiceStatus>({ phase: 'stopped', revision: 0, pid: null, error: null });
    const diagnostic = ref('');
    const busy = ref(false);
    const names = { stopped: '已停止', starting: '正在启动', ready: '服务就绪', stopping: '正在停止', failed: '服务异常' };
    const update = (next: ServiceStatus) => { if (next.revision >= status.value.revision) status.value = next; };
    let unsubscribe: (() => void) | undefined;
    onMounted(async () => {
      unsubscribe = window.desktop.onStatusChanged(update);
      const result = await window.desktop.getStatus();
      if (result.ok) update(result.value);
    });
    onUnmounted(() => unsubscribe?.());
    const ping = async () => {
      busy.value = true;
      try {
        const result = await window.desktop.ping({ text: 'AIAppNest' });
        diagnostic.value = result.ok ? `通信正常 · Node ${result.value.nodeVersion} · PID ${result.value.pid}` : result.error.message;
      } catch { diagnostic.value = '通信中断，请重新检查服务状态。'; }
      finally { busy.value = false; }
    };
    const retry = async () => {
      busy.value = true;
      try { const result = await window.desktop.retryService(); if (result.ok) update(result.value); else diagnostic.value = result.error.message; }
      catch { diagnostic.value = '重试失败。'; }
      finally { busy.value = false; }
    };
    return () => h('main', [
      h('header', [h('span', { class: 'brand' }, 'AIAppNest'), h('span', { class: 'tag' }, '基础工程')]),
      h('section', { class: 'intro' }, [h('p', { class: 'eyebrow' }, '本地 AI 应用工作台'), h('h1', '从可靠的连接开始'), h('p', '查看独立服务状态，后续能力将在这里逐步接入。')]),
      h('section', { class: 'card' }, [
        h('div', { class: 'status-line' }, [h('span', { class: `dot ${status.value.phase}` }), h('h2', { 'data-testid': 'phase', 'data-phase': status.value.phase, role: 'status' }, names[status.value.phase])]),
        h('p', status.value.error?.message ?? '通过受控进程通信管理服务，不开放本地网络端口。'),
        h('div', { class: 'actions' }, [
          h('button', { onClick: ping, disabled: status.value.phase !== 'ready' || busy.value }, '检查连接'),
          h('button', { class: 'secondary', onClick: retry, disabled: !['failed', 'stopped'].includes(status.value.phase) || busy.value }, '重试服务'),
        ]),
        h('p', { class: 'diagnostic', 'data-testid': 'diagnostic', role: 'status' }, diagnostic.value),
      ]),
      h('section', { class: 'boundary' }, [h('h2', '当前可用'), h('p', '服务状态 · 通信诊断 · 异常通知 · 手动重试'), h('h2', '后续接入'), h('p', '应用管理、数据库、模型凭据与 Pi 执行尚未实现。'), h('p', '关闭窗口将停止服务；服务异常后不会自动重放请求。')]),
    ]);
  },
})).mount('#app');
