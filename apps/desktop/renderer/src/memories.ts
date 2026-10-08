import { defineComponent, h, onMounted, ref, watch, type PropType } from 'vue';
import type { MemoryView, MemoryRequest, MemoryReply, MessageView } from '@aiappnest/contracts';
const labels = { preference:'偏好',fact:'事实',convention:'项目约定',term:'术语' };
const call = async (input:MemoryRequest) => { const result = await window.desktop.memories(input); if (!result.ok) throw new Error(result.error.message); return result.value; };
export const MemoryManager = defineComponent({
  props:{ appId:{ type:String,required:true },source:Object as PropType<MessageView> },emits:['close','source','newConversation'],
  setup(props,{ emit }) {
    const items = ref<MemoryView[]>([]),filter = ref(''),offset = ref(0),total = ref(0),feedback = ref(''),busy = ref(false);
    const editing = ref<MemoryView>(),content = ref(props.source?.content ?? ''),type = ref<MemoryView['type']>('preference'),priority = ref(0),expiry = ref(''),sourceId = ref(props.source?.id),deleting = ref<MemoryView>();
    const act = async (fn:()=>Promise<void>) => { if (busy.value) return; busy.value = true; feedback.value = ''; try { await fn(); } catch(e) { feedback.value = e instanceof Error ? e.message : '记忆操作失败'; } finally { busy.value = false; } };
    const load = async () => { const result = await call({ operation:'list',appId:props.appId,...(filter.value ? { type:filter.value as MemoryView['type'] } : {}),limit:20,offset:offset.value }); if (result.operation === 'list') { items.value = result.memories; total.value = result.total; } };
    const reset = () => { editing.value = undefined;content.value = '';type.value = 'preference';priority.value = 0;expiry.value = '';sourceId.value = undefined; };
    const button = (text:string,fn:()=>Promise<void>,disabled=false) => h('button',{ type:'button',disabled:busy.value || disabled,onClick:()=>act(fn) },text);
    onMounted(()=>act(load));
    return () => h('section',{ class:'card memory-manager','aria-label':'应用记忆管理' },[
      h('h2','应用记忆'),h('p','仅手动保存你确认的内容。不要保存密钥、密码或秘密；检测不能识别全部敏感信息。'),
      h('p','删除立即停止未来检索。旧会话、历史引用和备份可能仍含内容；聊天与用户文件不会随之删除。关联历史清理将在数据管理功能提供。'),
      button('返回聊天',async()=>emit('close')),button('从新会话开始',async()=>emit('newConversation')),
      h('p',{ role:'status','data-testid':'memory-feedback' },feedback.value),
      h('label',['按类型筛选',h('select',{ 'aria-label':'按类型筛选',disabled:busy.value,value:filter.value,onChange:(e:Event)=>{ filter.value=(e.target as HTMLSelectElement).value;offset.value=0;void act(load); } },[h('option',{ value:'' },'全部'),...Object.entries(labels).map(([value,label])=>h('option',{value},label))])]),
      ...items.value.map(m=>h('article',{ class:'card',key:m.id },[
        h('p',`${labels[m.type]} · v${m.version} · ${m.status} · 优先级 ${m.priority}`),h('p',m.content),
        h('small',`更新 ${new Date(m.updatedAt).toLocaleString()} · 有效期 ${m.expiresAt === null ? '不限' : new Date(m.expiresAt).toLocaleString()}`),
        m.sourceConversationId ? button('跳转来源',async()=>emit('source',m.sourceConversationId,m.sourceMessageId)) : h('span','手工新增'),
        button('编辑',async()=>{ editing.value=m;content.value=m.content;type.value=m.type;priority.value=m.priority;expiry.value=m.expiresAt===null ? '' : new Date(m.expiresAt).toISOString();sourceId.value=undefined; }),
        button('停用',async()=>{ await call({ operation:'disable',appId:props.appId,memoryId:m.id,expectedVersion:m.version });await load(); },m.status==='disabled'),
        button('删除',async()=>{ deleting.value=m; }),
      ])),
      button('上一页记忆',async()=>{ offset.value-=20;await load(); },offset.value===0),button('下一页记忆',async()=>{ offset.value+=20;await load(); },offset.value+20>=total.value),
      deleting.value ? h('div',{ role:'alertdialog','aria-label':'确认删除记忆' },[
        h('p','确认停止未来检索？历史引用仍保留旧版本以供审计。'),
        button('确认删除记忆',async()=>{ const m=deleting.value!;await call({ operation:'delete',appId:props.appId,memoryId:m.id,expectedVersion:m.version });deleting.value=undefined;await load();feedback.value='已删除；建议从新会话开始。'; }),
        button('取消删除记忆',async()=>{ deleting.value=undefined; }),
      ]) : null,
      h('h3',editing.value ? `确认编辑 v${editing.value.version}` : '确认新增记忆'),
      sourceId.value ? h('p',`来源消息 ${sourceId.value}；请确认或编辑内容后保存。`) : null,
      h('label',['记忆内容',h('textarea',{ 'aria-label':'记忆内容',maxlength:4000,value:content.value,onInput:(e:Event)=>{ content.value=(e.target as HTMLTextAreaElement).value; } })]),
      h('label',['记忆类型',h('select',{ 'aria-label':'记忆类型',value:type.value,onChange:(e:Event)=>{ type.value=(e.target as HTMLSelectElement).value as MemoryView['type']; } },Object.entries(labels).map(([value,label])=>h('option',{value},label)))]),
      h('label',['固定优先级',h('input',{ 'aria-label':'固定优先级',type:'number',min:0,max:100,value:priority.value,onInput:(e:Event)=>{ priority.value=Number((e.target as HTMLInputElement).value); } })]),
      h('label',['有效期（ISO 时间，留空不限）',h('input',{ 'aria-label':'记忆有效期',value:expiry.value,onInput:(e:Event)=>{ expiry.value=(e.target as HTMLInputElement).value; } })]),
      button('确认保存记忆',async()=>{
        const fields={ appId:props.appId,content:content.value,type:type.value,priority:priority.value,expiresAt:expiry.value ? Date.parse(expiry.value) : null,confirmed:true as const };
        await call(editing.value ? { operation:'update',...fields,memoryId:editing.value.id,expectedVersion:editing.value.version } : { operation:'save',...fields,...(sourceId.value ? { sourceMessageId:sourceId.value } : {}) });
        reset();offset.value=0;await load();feedback.value='记忆已保存；仅在启用记忆的应用版本中按相关性使用。';
      },!content.value.trim()),button('新增另一条',async()=>reset()),button('刷新记忆',load),
    ]);
  },
});
export const UsedMemories = defineComponent({
  props:{ appId:{ type:String,required:true },conversationId:{ type:String,required:true },runId:{ type:String,required:true },state:String },
  setup(props) {
    const items=ref<Extract<MemoryReply,{operation:'used'}>['memories']>([]),error=ref('');let generation=0;
    watch(()=>[props.runId,props.state],async()=>{ const token=++generation;try { const reply=await call({ operation:'used',appId:props.appId,conversationId:props.conversationId,runId:props.runId });if(token===generation && reply.operation==='used') items.value=reply.memories; }catch(e){ if(token===generation) error.value=e instanceof Error ? e.message : '读取记忆失败'; } },{ immediate:true });
    return ()=>h('section',{ 'aria-label':'本轮使用记忆' },[h('h4',`本轮参考记忆 · ${props.runId.slice(0,8)}`),h('p',error.value),
      ...items.value.map(item=>h('details',[h('summary',`${labels[item.memory.type]} · v${item.memory.version}${item.currentlyDeleted ? '（现已删除，保留历史引用）' : ''}`),h('p',item.memory.content),h('small',`${item.memory.id} · 顺序 ${item.position+1} · ${item.injectedTextHash}`)])),
      !items.value.length ? h('p','本轮没有注入记忆。') : h('small','显示发送前登记的参考版本；请求失败时不代表模型已使用。'),
    ]);
  },
});
