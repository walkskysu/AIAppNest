import { defineComponent, h, ref } from 'vue';
import { safeExternal } from './chat-state';
/** Small allowlist renderer: text and fenced code only; HTML and image syntax stay inert.
 * No innerHTML, remote resources, automatic link navigation or Markdown HTML parser. */
export const SafeContent = defineComponent({
  props: { text: { type: String, required: true } },
  setup(props) {
    const expanded = ref(false), notice = ref('');
    return () => {
      const text = expanded.value ? props.text : props.text.slice(0,8000);
      const parts = text.split(/(```[\s\S]*?```)/g);
      return h('div', { class: 'safe-content' }, [
        ...parts.map(part => part.startsWith('```') ? h('pre',[h('code',part.slice(3,-3).replace(/^[^\n]*\n/,''))]) : h('p',part)),
        ...[...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])].filter(url => safeExternal(url)).map(url => h('button', {
          class: 'text-link', onClick: async () => { const result = await window.desktop.openExternal(url); if (!result.ok) notice.value = result.error.message; },
        }, `打开外链：${url}`)),
        props.text.length > 8000 ? h('button', { class:'secondary',onClick: () => { expanded.value = !expanded.value; } },expanded.value ? '折叠长消息' : '展开完整消息') : null,
        h('button', { class: 'secondary', onClick: async () => { try { await navigator.clipboard.writeText(props.text); notice.value = '已复制原文'; } catch { notice.value = '复制失败，请选择文本复制'; } } }, '复制原文'),
        h('span',{ role:'status' },notice.value),
      ]);
    };
  },
});
