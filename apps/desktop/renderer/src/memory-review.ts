import { defineComponent,h,onMounted,ref } from 'vue';
import type { CandidateView,MemoryRequest,MemoryReply } from '@aiappnest/contracts';
const call=async(input:MemoryRequest)=>{const reply=await window.desktop.memories(input);if(!reply.ok) throw new Error(reply.error.message);return reply.value;};
export const CandidateReview=defineComponent({
  props:{appId:{type:String,required:true}},emits:['source','changed'],
  setup(props,{emit}) {
    const candidates=ref<CandidateView[]>([]),tasks=ref<Extract<MemoryReply,{operation:'tasks'}>['tasks']>([]),offset=ref(0),total=ref(0),taskOffset=ref(0),taskTotal=ref(0),busy=ref(false),error=ref('');
    const edits=ref<Record<string,string>>({});
    const load=async()=>{
      const list=await call({operation:'candidates',appId:props.appId,limit:10,offset:offset.value});
      if(list.operation==='candidates') {candidates.value=list.candidates;total.value=list.total;}
      const history=await call({operation:'tasks',appId:props.appId,limit:10,offset:taskOffset.value});
      if(history.operation==='tasks') {tasks.value=history.tasks;taskTotal.value=history.total;}
    };
    const act=async(fn:()=>Promise<void>)=>{if(busy.value) return;busy.value=true;error.value='';try {await fn();}catch(e){error.value=e instanceof Error?e.message:'审核失败';}finally{busy.value=false;}};
    const button=(label:string,fn:()=>Promise<void>,disabled=false)=>h('button',{type:'button',disabled:busy.value||disabled,onClick:()=>act(fn)},label);
    const review=async(c:CandidateView,action:'accept'|'reject'|'keep'|'replace'|'merge')=>{
      await call({operation:'review',appId:props.appId,memoryId:c.memory.id,expectedVersion:c.memory.version,confirmed:true,action,
        ...(edits.value[c.memory.id]!==undefined?{content:edits.value[c.memory.id]}:{}),targets:c.conflicts.map(m=>({id:m.id,version:m.version}))});
      delete edits.value[c.memory.id];await load();emit('changed');
    };
    onMounted(()=>act(load));
    return ()=>h('section',{'aria-label':'候选审核'},[
      h('h3',`待审核候选（${total.value}）`),h('p','候选不会注入聊天。疑似冲突仅按文本主题识别，不能完整判断事实；处理前保留用户已确认的旧记忆。替代或合并将停用列出的旧记忆并记录版本关系。'),
      h('p','删除来源会阻止接受候选；关闭提取不删除已有候选，也不撤销已确认记忆。拒绝不会在同来源重试时重新出现。'),
      h('p',{role:'status'},error.value),button('刷新候选与提取状态',load),
      !candidates.value.length?h('p','暂无待审核候选。'):null,
      ...candidates.value.map(c=>h('article',{class:'card',key:c.memory.id},[
        h('h4',`${c.conflicts.length?'疑似冲突':'候选'} · ${c.memory.type} · v${c.memory.version}`),h('p',c.memory.content),
        h('details',[h('summary','查看来源消息'),h('p',c.sourceContent??'来源已不可用'),h('small',`来源预览最多 6000 字符。会话 ${c.memory.sourceConversationId} · 运行 ${c.memory.sourceRunId} · 消息 ${c.memory.sourceMessageId}`),
          button('打开候选来源',async()=>emit('source',c.memory.sourceConversationId,c.memory.sourceMessageId),!c.sourceAvailable)]),
        ...c.conflicts.map(m=>h('div',{class:'card'},[h('strong',`${m.status==='active'?'已确认记忆':'另一条待审核候选'} v${m.version}`),h('p',m.content),
          m.sourceConversationId?button('打开旧记忆来源',async()=>emit('source',m.sourceConversationId,m.sourceMessageId)):h('small','手工新增，无来源消息')])),
        h('label',['修改候选或合并内容',h('textarea',{'aria-label':`审核内容 ${c.memory.id}`,maxlength:4000,value:edits.value[c.memory.id]??c.memory.content,onInput:(e:Event)=>{edits.value[c.memory.id]=(e.target as HTMLTextAreaElement).value;}})]),
        c.conflicts.length ? [button('保留旧记忆并拒绝候选',()=>review(c,'keep')),button('确认替代旧记忆',()=>review(c,'replace'),!c.sourceAvailable),
          button('确认合并为编辑内容',()=>review(c,'merge'),!c.sourceAvailable||!edits.value[c.memory.id]?.trim())] : button('确认接受（含修改）',()=>review(c,'accept'),!c.sourceAvailable),
        button('拒绝候选',()=>review(c,'reject')),
      ])),
      button('上一页候选',async()=>{offset.value-=10;await load();},offset.value===0),button('下一页候选',async()=>{offset.value+=10;await load();},offset.value+10>=total.value),
      h('details',[h('summary',`提取任务（${taskTotal.value}）`),h('p','提取失败不改变原任务结果。仅显式重试，最多 3 次调用；排队受主调度配额限制。'),
        ...tasks.value.map(task=>h('p',{key:task.id},[`${task.state} · 尝试 ${task.attempts}/3 · ${task.error??'无错误'} · 来源运行 ${task.sourceRunId} `,
          task.state==='failed'?button('重试提取',async()=>{await call({operation:'retry',appId:props.appId,taskId:task.id,expectedVersion:task.version});await load();},task.attempts>=3):null])),
        button('上一页提取任务',async()=>{taskOffset.value-=10;await load();},taskOffset.value===0),button('下一页提取任务',async()=>{taskOffset.value+=10;await load();},taskOffset.value+10>=taskTotal.value),
      ]),
    ]);
  },
});
export const MemorySearch=defineComponent({
  props:{appId:{type:String,required:true}},emits:['source'],
  setup(props,{emit}) {
    const query=ref(''),kind=ref<'memory'|'message'>('memory'),mode=ref<'phrase'|'terms'|'fuzzy'>('phrase'),offset=ref(0),total=ref(0),hits=ref<Extract<MemoryReply,{operation:'search'}>['hits']>([]),busy=ref(false),error=ref(''),searched=ref(false);
    const search=async(reset=false)=>{if(busy.value)return;busy.value=true;error.value='';if(reset)offset.value=0;try{const result=await call({operation:'search',appId:props.appId,query:query.value,kind:kind.value,mode:mode.value,limit:10,offset:offset.value});
      if(result.operation==='search'){hits.value=result.hits;total.value=result.total;searched.value=true;}}catch(e){hits.value=[];total.value=0;error.value=e instanceof Error?e.message:'搜索失败';}finally{busy.value=false;}};
    return()=>h('section',{'aria-label':'中文搜索'},[
      h('h3','搜索本应用记忆与会话'),h('form',{onSubmit:(e:Event)=>{e.preventDefault();void search(true);}},[
        h('input',{'aria-label':'搜索词',maxlength:200,value:query.value,onInput:(e:Event)=>{query.value=(e.target as HTMLInputElement).value;}}),
        h('select',{'aria-label':'搜索范围',value:kind.value,onChange:(e:Event)=>{kind.value=(e.target as HTMLSelectElement).value as typeof kind.value;}},[h('option',{value:'memory'},'有效记忆'),h('option',{value:'message'},'会话消息')]),
        h('select',{'aria-label':'匹配方式',value:mode.value,onChange:(e:Event)=>{mode.value=(e.target as HTMLSelectElement).value as typeof mode.value;}},[h('option',{value:'phrase'},'短语'),h('option',{value:'terms'},'术语 n-gram'),h('option',{value:'fuzzy'},'基础模糊')]),
        h('button',{type:'submit',disabled:busy.value||!query.value.trim()},'搜索'),
      ]),h('p',{role:'status'},error.value||(searched.value?`共 ${total.value} 条结果${!total.value?'，试试其他词或基础模糊匹配。':''}`:'')),
      ...hits.value.map(hit=>h('article',{class:'card',key:hit.id},[h('p',hit.snippet),h('details',[h('summary',hit.kind==='memory'?`记忆 v${hit.version}`:'完整消息'),h('p',hit.content)]),
        hit.conversationId?h('button',{type:'button',onClick:()=>emit('source',hit.conversationId,hit.kind==='message'?hit.id:null)},'跳转会话'):null])),
      h('button',{disabled:busy.value||offset.value===0,onClick:()=>{offset.value-=10;void search();}},'上一页搜索结果'),
      h('button',{disabled:busy.value||offset.value+10>=total.value,onClick:()=>{offset.value+=10;void search();}},'下一页搜索结果'),
      h('button',{disabled:busy.value,onClick:async()=>{busy.value=true;try{await call({operation:'rebuild',appId:props.appId});error.value='索引重建完成。';}catch{error.value='重建失败，原始消息和记忆保留。';}finally{busy.value=false;}}},'重建派生搜索索引'),
    ]);
  },
});
