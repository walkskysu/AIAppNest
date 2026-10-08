import { MemoryManager, UsedMemories } from './memories';
import { AttachmentInput, FilePanel } from './files';
import { defineComponent, h, nextTick, onMounted, onUnmounted, ref, type PropType } from 'vue';
import type { AppView, AppRevisionView, ChatRequest, ConversationView, MessageView, PolicyApproval, PolicyGrant, Result, RunRequest } from '@aiappnest/contracts';
import { RunFeed, terminal, stateNames, shouldSubmit, type RunView } from './chat-state';
import { SafeContent } from './safe-content';
const unwrap = <T>(result: Result<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };

export const ChatWorkspace = defineComponent({
  props: { app: { type: Object as PropType<AppView>, required: true }, ready: Boolean, trialConversation: String },
  emits: ['back','settings'],
  setup(props,{ emit }) {
    const conversations = ref<ConversationView[]>([]), selected = ref<ConversationView>(), messages = ref<MessageView[]>([]), runs = ref<RunView[]>([]);
    const query = ref(''), total = ref(0), offset = ref(0), messageTotal = ref(0), prompt = ref(''), rename = ref('');
    const feedback = ref(''), busy = ref(false), approvals = ref<PolicyApproval[]>([]), grants = ref<PolicyGrant[]>([]), revision = ref<AppRevisionView>();
    const feeds = ref(new Map<string,RunFeed>()), deletion = ref(false), retry = ref<RunView>(), composing = ref(false), input = ref<HTMLTextAreaElement>();
    const memoryPage = ref(false), memorySource = ref<MessageView>(), memoryRunId = ref('');
    const attachmentIds = ref<string[]>([]), uploading = ref(false), inputGeneration = ref(0);
    let disposed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Extract<RunRequest,{ operation:'submit' }> | undefined;
    const subscriptions = new Map<string,string>();
    const scope = () => ({ appId: props.app.id, conversationId: selected.value!.id });
    const chat = async (request: ChatRequest) => unwrap(await window.desktop.chat(request));
    const runCall = async (request: RunRequest) => unwrap(await window.desktop.runs(request));
    const action = async (fn: () => Promise<void>) => {
      if (busy.value || disposed) return;
      busy.value = true; feedback.value = '';
      try { await fn(); } catch (error) { feedback.value = `${error instanceof Error ? error.message : '连接失败'} 请刷新查询服务状态；不会自动重发任务。`; }
      finally { busy.value = false; }
    };
    const list = async () => {
      const reply = await chat({ operation:'list',appId:props.app.id,query:query.value,limit:20,offset:offset.value });
      if (!disposed && reply.operation === 'list') { conversations.value = reply.conversations; total.value = reply.total; }
    };
    const unsubscribe = () => {
      for (const subscriptionId of subscriptions.values()) void window.desktop.runs({ operation:'unsubscribe',subscriptionId }).catch(() => {});
      subscriptions.clear();
    };
    const loadHistory = async (reset = false) => {
      if (!selected.value) return;
      const token = generation, current = scope();
      const reply = await chat({ operation:'history',...current,limit:100,offset:reset ? 0 : messages.value.length });
      if (disposed || token !== generation || reply.operation !== 'history') return;
      selected.value = reply.conversation; runs.value = reply.runs; messageTotal.value = reply.total;
      const records = new Map((reset ? [] : messages.value).map(m => [m.id,m]));
      for (const message of reply.messages) records.set(message.id,message);
      messages.value = [...records.values()].sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    };
    const poll = async (token: number) => {
      if (disposed || token !== generation || !selected.value) return;
      try {
        for (const run of runs.value) {
          let feed = feeds.value.get(run.id);
          if (!feed) { feed = new RunFeed(run.id); feeds.value.set(run.id,feed); }
          // Completed runs already fully replayed need no listener.
          if (terminal(run) && feed.seq > 0 && !subscriptions.has(run.id)) continue;
          const subscriptionId = subscriptions.get(run.id);
          const result = await runCall(subscriptionId ? { operation:'next',subscriptionId,afterSeq:feed.seq } : { operation:'subscribe',appId:run.appId,conversationId:run.conversationId,runId:run.id,afterSeq:feed.seq });
          if (result.operation !== 'next' && result.operation !== 'subscribe') continue;
          if (disposed || token !== generation) { await window.desktop.runs({ operation:'unsubscribe',subscriptionId:result.subscriptionId }); return; }
          subscriptions.set(run.id,result.subscriptionId); feed.merge(result.events);
          const latest = await runCall({ operation:'get',appId:run.appId,conversationId:run.conversationId,runId:run.id });
          if (disposed || token !== generation) return;
          if (latest.operation === 'get') Object.assign(run,latest.run);
          if (result.terminal) {
            await window.desktop.runs({ operation:'unsubscribe',subscriptionId:result.subscriptionId }); subscriptions.delete(run.id);
            await loadHistory(true);
          }
        }
        const waiting = runs.value.filter(r => r.state === 'waiting_approval');
        const pendingApprovals: PolicyApproval[] = [];
        for (const run of waiting) {
          const reply = unwrap(await window.desktop.policy({ operation:'approvals.list',appId:run.appId,conversationId:run.conversationId,runId:run.id }));
          if (reply.operation === 'approvals.list') pendingApprovals.push(...reply.approvals.filter(a => a.state === 'pending'));
        }
        if (disposed || token !== generation) return;
        approvals.value = pendingApprovals;
      } catch (error) {
        if (!disposed && token === generation) { feedback.value = `${error instanceof Error ? error.message : '连接中断'} 请点击刷新历史恢复监听。`; unsubscribe(); }
        return;
      }
      // 60ms batches; only one poll can be outstanding per page generation.
      if (!disposed && token === generation) timer = setTimeout(() => { void poll(token); },60);
    };
    const open = async (conversationId: string) => {
      generation++; inputGeneration.value++; attachmentIds.value = []; uploading.value = false; clearTimeout(timer); unsubscribe(); const token = generation;
      messages.value = []; runs.value = []; memoryRunId.value = ''; feeds.value = new Map(); approvals.value = []; grants.value = []; pending = undefined;
      deletion.value = false; retry.value = undefined; prompt.value = ''; revision.value = undefined;
      const reply = await chat({ operation:'history',appId:props.app.id,conversationId,limit:100,offset:0 });
      if (disposed || token !== generation || reply.operation !== 'history') return;
      selected.value = reply.conversation; rename.value = reply.conversation.title; messages.value = reply.messages; runs.value = reply.runs; messageTotal.value = reply.total;
      const rev = unwrap(await window.desktop.apps({ operation:'revision',appId:props.app.id,revisionId:reply.conversation.revisionId }));
      if (disposed || token !== generation) return;
      if (rev.operation === 'revision') revision.value = rev.revision;
      const policy = unwrap(await window.desktop.policy({ operation:'grants.list',...scope() }));
      if (disposed || token !== generation) return;
      if (policy.operation === 'grants.list') grants.value = policy.grants.filter(g => !g.revoked);
      void poll(token); await nextTick(); input.value?.focus();
    };
    const newConversation = async () => {
      const result = await chat({ operation:'create',appId:props.app.id,conversationId:crypto.randomUUID(),title:'新对话' });
      if (result.operation === 'create') { memoryPage.value=false;await list();await open(result.conversation.id); }
    };
    const openSource = async (conversationId:string,messageId:string) => {
      memoryPage.value=false;await open(conversationId);
      while (!messages.value.some(m=>m.id===messageId) && messages.value.length<messageTotal.value) await loadHistory();
      await nextTick();document.getElementById('message-'+messageId)?.scrollIntoView();
    };
    const send = async () => {
      if (!selected.value || !prompt.value.trim() || uploading.value) return;
      // On uncertain transport keep the exact request, including its text. No automatic resend.
      pending ??= { operation:'submit',...scope(),revisionId:selected.value.revisionId,requestId:crypto.randomUUID(),text:prompt.value,attachmentIds:[...attachmentIds.value],...(retry.value ? { retryOf:retry.value.id } : {}) };
      const result = await runCall(pending);
      if (result.operation !== 'submit') return;
      pending = undefined; prompt.value = ''; retry.value = undefined;
      await open(result.run.conversationId);
    };
    const stop = async () => { for (const run of runs.value.filter(r => !terminal(r))) await runCall({ operation:'cancel',appId:run.appId,conversationId:run.conversationId,runId:run.id }); };
    const remove = async () => {
      const result = await chat({ operation:'delete',...scope(),scope:'chat-and-attachments',preserveMemory:true,preserveArtifacts:true });
      if (result.operation === 'delete' && result.archived) {
        generation++; clearTimeout(timer); unsubscribe(); selected.value = undefined; deletion.value = false; await list();
        feedback.value = '会话已移入回收区；来源记忆和产物已保留。';
      } else feedback.value = '正在停止并回收进程，请稍后点击“确认移入回收区”查询终止结果。';
    };
    const button = (label: string, fn: () => Promise<void>, disabled = false) => h('button',{ type:'button',class:'secondary',disabled:busy.value || !props.ready || disabled,onClick:() => action(fn) },label);
    onMounted(() => { void action(async () => { if (props.trialConversation) await open(props.trialConversation); else await list(); }); });
    onUnmounted(() => { disposed = true; generation++; clearTimeout(timer); unsubscribe(); });
    return () => memoryPage.value ? h(MemoryManager,{ appId:props.app.id,source:memorySource.value,onClose:()=>{ memoryPage.value=false; },onSource:(c:string,m:string)=>action(()=>openSource(c,m)),onNewConversation:()=>action(newConversation) }) : h('section',{ class:'chat-workspace','data-testid':'app-space' },[
      h('header',[h('h2',props.app.name),h('span',revision.value ? `模型：${revision.value.snapshot.provider.modelId} · 固定版本 ${revision.value.revision}` : '选择或新建会话'),
        button('返回应用首页',async () => { emit('back'); }),button('应用设置',async () => { emit('settings'); }),
        !props.trialConversation ? button('管理应用记忆',async()=>{ memorySource.value=undefined;memoryPage.value=true; }) : null]),
      h('p',{ role:'status','data-testid':'chat-feedback' },feedback.value),
      h('div',{ class:'chat-columns' },[
        h('aside',{ class:'chat-sidebar' },[
          props.trialConversation ? h('p','隔离试运行 · 不注入正式记忆 · 诊断保留到数据管理清理') : [
            button('新建对话',async () => { const result = await chat({ operation:'create',appId:props.app.id,conversationId:crypto.randomUUID(),title:'新对话' }); if (result.operation === 'create') { await list(); await open(result.conversation.id); } },!props.app.currentRevisionId),
            h('form',{ onSubmit:(e:Event) => { e.preventDefault(); offset.value = 0; void action(list); } },[
              h('input',{ 'aria-label':'搜索当前应用会话',value:query.value,onInput:(e:Event) => { query.value = (e.target as HTMLInputElement).value; } }),button('搜索会话',async () => { offset.value = 0; await list(); }),
            ]),
            ...conversations.value.map(c => button(c.title,() => open(c.id))),
            !conversations.value.length ? h('p','暂无会话。新建对话后输入任务即可开始。') : null,
            button('上一页会话',async () => { offset.value -= 20; await list(); },offset.value === 0),button('下一页会话',async () => { offset.value += 20; await list(); },offset.value + 20 >= total.value),
          ],
          selected.value ? [h('input',{ 'aria-label':'会话名称',value:rename.value,onInput:(e:Event) => { rename.value = (e.target as HTMLInputElement).value; } }),
            button('重命名会话',async () => { await chat({ operation:'rename',...scope(),title:rename.value }); await list(); }),
            button('删除会话',async () => { deletion.value = true; }),
          ] : null,
        ]),
        h('div',{ class:'chat-center' },selected.value ? [
          deletion.value ? h('section',{ class:'card',role:'alertdialog','aria-label':'删除会话范围' },[
            h('p','聊天和附件移入回收区。正在执行的任务须先停止；已发生的外部操作不会回滚。'),
            h('label',[h('input',{ type:'checkbox',checked:true,disabled:true }),'保留来源记忆（删除选项待数据管理接入）']),
            h('label',[h('input',{ type:'checkbox',checked:true,disabled:true }),'保留产物（删除选项待数据管理接入）']),
            button('确认移入回收区',remove),button('取消删除',async () => { deletion.value = false; }),
          ]) : null,
          h('div',{ class:'chat-history','aria-label':'聊天历史' },[
            !messages.value.length ? h('p',revision.value?.snapshot.config.openingMessage || '输入第一条任务。打开此页面不会启动模型。') : null,
            ...messages.value.map(message => h('article',{ class:`message ${message.role}`,key:message.id,id:'message-'+message.id },[
              !props.trialConversation && message.status==='complete' && ['user','assistant'].includes(message.role) ? button('记住这条',async()=>{ memorySource.value=message;memoryPage.value=true; }) : null,
              h('strong',{ user:'你',assistant:'助手',tool:'工具结果',system:'系统' }[message.role]),
              message.role === 'tool' ? h('details',[h('summary','查看工具结果'),h(SafeContent,{ text:message.content })]) : h(SafeContent,{ text:message.content }),
            ])),
            button('加载更多历史',() => loadHistory(),messages.value.length >= messageTotal.value),
            ...runs.value.map(run => h('section',{ class:'run-card',key:run.id },[
              h('p',{ role:'status' },stateNames[run.state]),
              run.error === 'MEMORY_PREPARATION_FAILED' ? h('p',{ role:'alert' },'记忆检索、预算或审计保存失败，本轮未发送模型请求。请检查存储与服务状态后手动重试。') : null,
              run.state === 'failed' ? h('p','模型或工具执行失败。请检查模型连接、依赖和会话授权；确认副作用后可手动重试。') : null,
              run.state === 'interrupted' ? h('p','执行已中断。历史已保留，请检查服务状态并手动决定是否重试。') : null,
              !messages.value.some(m => m.runId === run.id && m.role === 'assistant') && feeds.value.get(run.id)?.text ? h(SafeContent,{ text:feeds.value.get(run.id)!.text }) : null,
              ...[...(feeds.value.get(run.id)?.tools.values() ?? [])].filter(tool => !tool.result || !messages.value.some(m => m.runId === run.id && m.role === 'tool')).map(tool => h('details',[h('summary',`工具：${tool.name}`),h(SafeContent,{ text:tool.result ?? '正在处理' })])),
              ['failed','interrupted','cancelled'].includes(run.state) ? button('手动重试',async () => {
                const message = messages.value.find(m => m.runId === run.id && m.role === 'user');
                if (!message) { feedback.value = '请先加载对应用户消息所在历史页。'; return; }
                prompt.value = message.content; retry.value = run; pending = undefined; await nextTick(); input.value?.focus();
              }) : null,
              h('details',[h('summary','运行诊断'),h('pre',`Run ${run.id}\n${run.error ?? ''}\n事件序号 ${feeds.value.get(run.id)?.seq ?? 0}`)]),
            ])),
          ]),
          ...approvals.value.map(approval => h('section',{ class:'card',role:'alert' },[
            h('h3','需要你的确认'),h('p',`操作：${approval.tool} · 目标：${approval.target ?? approval.resource}`),h('p',approval.impact ?? '允许后执行该操作。拒绝将停止本次运行。'),
            ...(['allow','deny'] as const).map(decision => button(decision === 'allow' ? '允许本次操作' : '拒绝并停止',async () => {
              unwrap(await window.desktop.policy({ operation:'approvals.decide',appId:approval.appId,conversationId:approval.conversationId,runId:approval.runId,approvalId:approval.id,digest:approval.digest,decision }));
            })),
          ])),
          retry.value ? h('p',{ role:'alert' },'重试会创建新的执行并保留原执行关联；之前可能已发生文件写入或外部副作用。确认后点击发送。') : null,
          h(AttachmentInput,{ key:`${selected.value.id}:${inputGeneration.value}`,appId:props.app.id,conversationId:selected.value.id,disabled:busy.value || !!pending || deletion.value,onChange:(ids:string[]) => { attachmentIds.value = ids; },onUploading:(value:boolean) => { uploading.value = value; } }),
          h('form',{ onSubmit:(e:Event) => { e.preventDefault(); if (!composing.value) void action(send); } },[
            h('textarea',{ ref:input,'aria-label':'输入任务',value:prompt.value,disabled:busy.value || !!pending || deletion.value || selected.value.status !== 'active',
              onInput:(e:Event) => { prompt.value = (e.target as HTMLTextAreaElement).value; },onCompositionstart:() => { composing.value = true; },onCompositionend:() => { composing.value = false; },
              onKeydown:(e:KeyboardEvent) => { if (shouldSubmit(e,composing.value)) { e.preventDefault(); void action(send); } } }),
            button(pending ? '用相同请求确认提交' : '发送',send,uploading.value || !prompt.value.trim() || deletion.value || selected.value.status !== 'active'),
            button('停止',stop,!runs.value.some(r => !terminal(r))),button('刷新历史',() => open(selected.value!.id)),
          ]),
        ] : [h('p',props.app.currentRevisionId ? '从左侧选择会话或新建对话。' : '请先在创建向导中完成模型配置、试运行和发布。')]),
        h('aside',{ class:'chat-capabilities' },[
          h('h3','应用能力'),h('p',revision.value?.snapshot.config.role ?? props.app.description),
          h('details',[h('summary','会话固定版本'),h('pre',revision.value ? `${revision.value.id}\n配置哈希 ${revision.value.configHash}` : '尚未选择会话')]),
          selected.value ? [h('h3','会话授权'),...grants.value.map(grant => h('p',`${grant.resource} · ${grant.access} · ${grant.root}`)),
            button('授权产物目录写入',async () => {
              unwrap(await window.desktop.policy({ operation:'grants.create',...scope(),resource:'output',access:'write',confirmation:'always' })); await open(selected.value!.id);
            }),
            ...(['read','write'] as const).map(access => button(`授权工作区${access === 'read' ? '读取' : '写入'}`,async () => {
              unwrap(await window.desktop.policy({ operation:'grants.create',...scope(),resource:'workspace',access,confirmation:'always' })); await open(selected.value!.id);
            })),
            button('授权外部目录',async () => { const selection = unwrap(await window.desktop.selectGrantDirectory(scope())); if (selection) { unwrap(await window.desktop.policy({ operation:'grants.create',...scope(),resource:'external',token:selection.token,access:'write',confirmation:'always' })); await open(selected.value!.id); } }),
            button('确认可信自动化',async () => { unwrap(await window.desktop.selectTrustedAutomation(scope())); }),
          ] : null,
          runs.value.length ? [h('label',['查看执行的参考记忆',h('select',{ 'aria-label':'查看执行的参考记忆',value:memoryRunId.value || runs.value.at(-1)?.id,onChange:(e:Event)=>{ memoryRunId.value=(e.target as HTMLSelectElement).value; } },runs.value.map(run=>h('option',{ value:run.id },`${new Date(run.createdAt).toLocaleString()} · ${run.id.slice(0,8)}`)))]),
            ...runs.value.filter(run=>run.id===(memoryRunId.value || runs.value.at(-1)?.id)).map(run=>h(UsedMemories,{ key:run.id,appId:run.appId,conversationId:run.conversationId,runId:run.id,state:run.state })),
          ] : null,
          selected.value ? h(FilePanel,{ key:selected.value.id,appId:props.app.id,conversationId:selected.value.id,runs:runs.value }) : null,
        ]),
      ]),
    ]);
  },
});
