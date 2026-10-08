import { defineComponent, h, onUnmounted, onMounted, ref, watch, type PropType } from 'vue';
import type { FileReply, FileRequest, FileView, Result } from '@aiappnest/contracts';
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const call = async (input: FileRequest) => unwrap(await window.desktop.files(input));
export const AttachmentInput = defineComponent({
  props:{ appId:{ type:String,required:true },conversationId:{ type:String,required:true },disabled:Boolean },
  emits:['change','uploading'],
  setup(props,{ emit }) {
    const files = ref<FileView[]>([]), status = ref(''), loading = ref(false);
    let token: string | undefined, disposed = false;
    const scope = () => ({ appId:props.appId,conversationId:props.conversationId });
    const cancel = async () => { if (token) await call({ operation:'attachments.cancel',...scope(),token }); };
    const select = async () => {
      loading.value = true; emit('uploading',true); status.value = '正在选择并导入附件…';
      try {
        const selection = unwrap(await window.desktop.selectAttachment(scope()));
        if (!selection) { status.value = '已取消选择'; return; }
        token = selection.token;
        if (disposed) { await cancel(); return; }
        status.value = `正在导入 ${selection.displayName}…`;
        const reply = await call({ operation:'attachments.import',...scope(),token });
        if (!disposed && reply.operation === 'attachments.import') {
          files.value.push(reply.file); emit('change',files.value.map(f => f.id)); status.value = '导入完成';
        }
      } catch (error) { if (!disposed) status.value = `导入失败：${error instanceof Error ? error.message : '连接失败'}`; }
      finally { token = undefined; loading.value = false; if (!disposed) emit('uploading',false); }
    };
    onUnmounted(() => { disposed = true; void cancel().catch(() => {}); });
    return () => h('section',{ 'aria-label':'输入附件' },[
      h('button',{ type:'button',disabled:props.disabled || loading.value || files.value.length >= 3,onClick:select },'添加文本附件'),
      loading.value ? h('button',{ type:'button',onClick:() => cancel().catch(error => { status.value = error.message; }) },'取消导入') : null,
      h('small','UTF-8 文本，单文件 256 KiB，每次最多 3 个'),h('p',{ role:'status' },status.value),
      ...files.value.map(file => h('div',{ key:file.id },[
        h('span',`${file.displayName} · ${file.size} 字节 · 已导入`),
        h('button',{ type:'button',disabled:props.disabled,onClick:() => { files.value = files.value.filter(f => f.id !== file.id); emit('change',files.value.map(f => f.id)); } },'移除输入引用'),
      ])),files.value.length ? h('small','移除引用不会删除托管副本或影响已提交任务。原始文件始终保留。') : null,
    ]);
  },
});
const statuses = { ready:'完整性已校验',missing:'文件缺失',changed:'文件内容已变化',forbidden:'路径无法安全访问','type-mismatch':'扩展名与内容不符' };
export const FilePanel = defineComponent({
  props:{ appId:{ type:String,required:true },conversationId:{ type:String,required:true },runs:{ type:Array as PropType<{ id:string }[]>,required:true } },
  setup(props) {
    const files = ref<FileView[]>([]), runId = ref(''), feedback = ref(''), offset = ref(0), more = ref(false);
    const preview = ref<Extract<FileReply,{ operation:'artifacts.preview' }>>();
    let disposed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const scope = () => ({ appId:props.appId,conversationId:props.conversationId });
    const load = async () => {
      const version = ++generation;
      try {
        const reply = await call({ operation:'artifacts.list',...scope(),...(runId.value ? { runId:runId.value } : {}),offset:offset.value });
        if (disposed || version !== generation || reply.operation !== 'artifacts.list') return;
        files.value = reply.files; more.value = reply.hasMore;
        if (preview.value) {
          const latest = files.value.find(f => f.id === preview.value!.file.id);
          if (!latest || latest.status !== 'ready') preview.value = undefined;
        }
      } catch (error) { if (!disposed) { feedback.value = error instanceof Error ? error.message : '读取失败'; preview.value = undefined; } }
    };
    const action = async (fn: () => Promise<void>) => { feedback.value = ''; try { await fn(); } catch (error) { feedback.value = error instanceof Error ? error.message : '操作失败'; } };
    const button = (label:string,fn:() => Promise<void>,disabled=false) => h('button',{ type:'button',disabled,onClick:() => action(fn) },label);
    const poll = async () => { await load(); if (!disposed) timer = setTimeout(poll,2000); };
    onMounted(poll); onUnmounted(() => { disposed = true; generation++; clearTimeout(timer); });
    watch(runId,() => { offset.value = 0; preview.value = undefined; void load(); });
    return () => h('section',{ 'aria-label':'文件产物','data-testid':'file-panel' },[
      h('h3','文件产物'),h('select',{ 'aria-label':'产物执行范围',value:runId.value,onChange:(e:Event) => { runId.value = (e.target as HTMLSelectElement).value; } },[
        h('option',{ value:'' },'当前会话全部产物'),...props.runs.map((run,index) => h('option',{ value:run.id },`任务 ${index+1}`)),
      ]),h('p',{ role:'status' },feedback.value),
      ...files.value.map(file => h('article',{ key:file.id },[
        h('strong',file.displayName),h('p',`${file.mimeType} · ${file.size} 字节 · ${statuses[file.status]}`),
        h('details',[h('summary','文件详情'),h('p',new Date(file.createdAt).toLocaleString()),h('code',`Run ${file.runId}`),h('p',file.hash ? `SHA-256 ${file.hash}` : '完整性不可确认')]),
        button('安全预览',async () => { const reply = await call({ operation:'artifacts.preview',...scope(),artifactId:file.id }); if (!disposed && reply.operation === 'artifacts.preview') preview.value = reply; }),
        button('打开所在目录',async () => { await call({ operation:'artifacts.open',...scope(),artifactId:file.id,mode:'folder' }); },file.status !== 'ready'),
        button('用外部应用打开',async () => { await call({ operation:'artifacts.open',...scope(),artifactId:file.id,mode:'external' }); },!file.externalOpen),
      ])),!files.value.length ? h('p','本范围暂无已登记产物。') : null,
      button('上一页产物',async () => { offset.value -= 20; await load(); },offset.value === 0),button('下一页产物',async () => { offset.value += 20; await load(); },!more.value),
      preview.value ? h('section',{ 'aria-label':'安全文件预览' },[
        h('h4',preview.value.file.displayName),h('p',statuses[preview.value.file.status]),
        // Text nodes only: no HTML/Markdown parser, iframe, object or automatic link/image resolution.
        preview.value.preview.kind === 'text' ? h('pre',preview.value.preview.text)
          : preview.value.preview.kind === 'image' ? h('img',{ alt:preview.value.file.displayName,src:`data:${preview.value.preview.mimeType};base64,${preview.value.preview.data}` })
            : h('p',preview.value.preview.reason),
        button('关闭预览',async () => { preview.value = undefined; }),
      ]) : null,
    ]);
  },
});
