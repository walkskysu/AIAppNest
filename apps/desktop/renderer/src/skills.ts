import { defineComponent, h, onMounted, ref, watch } from 'vue';
import type { SkillReport, SkillRequest, SkillView } from '@aiappnest/contracts';

const status = { satisfied:'已满足',missing:'缺失',unverified:'未验证' };
export const SkillLibrary = defineComponent({
  props:{ ready:Boolean },
  setup(props) {
    const skills = ref<SkillView[]>([]), selected = ref<SkillView>(), report = ref<SkillReport>();
    const feedback = ref(''), busy = ref(false), offset = ref(0), total = ref(0);
    const call = async (input: SkillRequest) => {
      const result = await window.desktop.skills(input); if (!result.ok) throw new Error(result.error.message); return result.value;
    };
    const list = async () => { const result = await call({ operation:'list',limit:12,offset:offset.value }); if (result.operation === 'list') { skills.value = result.skills; total.value = result.total; } };
    const action = async (fn: () => Promise<void>) => {
      if (busy.value) return; busy.value = true; feedback.value = '';
      try { await fn(); } catch (error) { feedback.value = error instanceof Error ? error.message : '操作失败。'; }
      finally { busy.value = false; }
    };
    const button = (label: string, fn: () => Promise<void>, disabled = false) => h('button',{ type:'button',class:'secondary',disabled:busy.value || !props.ready || disabled,onClick:() => action(fn) },label);
    onMounted(() => { if (props.ready) void action(list); });
    watch(() => props.ready,ready => { if (ready) void action(list); });
    return () => h('section',{ class:'card','data-testid':'skill-library' },[
      h('h2','技能库'), h('p','不可变源包按 ID、版本和 SHA-256 绑定。依赖安装属于独立流程；导入和校验不会执行脚本。'),
      button('导入 Skill 文件夹',async () => {
        const selection = await window.desktop.selectSkillDirectory();
        if (!selection.ok) throw new Error(selection.error.message); if (!selection.value) return;
        const result = await call({ operation:'import',token:selection.value.token });
        if (result.operation === 'import') {
          selected.value = result.skill ?? undefined; report.value = result.report;
          feedback.value = result.skill ? result.duplicate ? '相同内容已存在，未重复导入。':'导入成功。' : '导入未通过，请查看定位信息。';
        }
        offset.value = 0; await list();
      }), button('刷新技能库',list), h('p',{ role:'status' },feedback.value),
      h('ul',skills.value.map(skill => h('li',{ key:`${skill.id}:${skill.version}` },[
        h('strong',`${skill.name} · ${skill.version}（${skill.versionOrigin === 'platform' ? '平台分配版本':'上游声明版本'}）`),
        h('p',`ID ${skill.id} · 来源 ${skill.source}`),
        button('查看详情',async () => { const result = await call({ operation:'get',id:skill.id,version:skill.version }); if (result.operation === 'get') { selected.value = result.skill; report.value = result.skill.report; } }),
      ]))), h('p',`共 ${total.value} 个版本`),
      button('上一页技能',async () => { offset.value -= 12; await list(); },offset.value === 0),
      button('下一页技能',async () => { offset.value += 12; await list(); },offset.value + 12 >= total.value),
      selected.value ? h('section',[
        h('h3',selected.value.name),h('p',selected.value.description), h('p',{ class:'skill-hash' },`SHA-256 ${selected.value.sha256}`),
        h('p',`入口 ${selected.value.entryFile} · 导入 ${new Date(selected.value.importedAt).toLocaleString()}`),
        button('重新校验完整性与依赖',async () => { const result = await call({ operation:'validate',id:selected.value!.id,version:selected.value!.version }); if (result.operation === 'validate') report.value = result.report; }),
        button('删除未引用源包',async () => { await call({ operation:'delete',id:selected.value!.id,version:selected.value!.version }); selected.value = undefined; report.value = undefined; await list(); }),
      ]) : null,
      report.value ? h('section',{ 'data-testid':'skill-report' },[
        h('h3',report.value.valid ? '静态校验通过':'静态校验失败'),
        h('p',`${report.value.files.length} 个文件 · ${report.value.files.reduce((sum,f) => sum + f.bytes,0)} 字节`),
        h('h4','依赖检测'),h('ul',report.value.dependencies.map(d => h('li',`${d.name} ${d.constraint}：${status[d.status]} — ${d.detail}`))),
        h('h4','权限需求声明'),h('p',report.value.capabilities.join('、') || '未声明'),
        h('p',`allowed-tools：${report.value.allowedTools.join('、') || '未声明'}。这些声明不授予实际工具权限。`),
        h('h4','脚本清单（未执行）'),h('ul',report.value.scripts.map(path => h('li',path))),
        h('h4','校验定位'),h('ul',report.value.diagnostics.map(d => h('li',`${d.path}:${d.line} · ${d.status === 'error' ? '错误':'未验证'} · ${d.code} · ${d.message}`))),
      ]) : null,
    ]);
  },
});
