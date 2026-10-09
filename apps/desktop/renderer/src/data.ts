import { defineComponent,h,onMounted,onUnmounted,ref } from 'vue';
import type {DataRequest,DataReply,DataJob} from '@aiappnest/contracts';

export const DataSettings=defineComponent({
  emits:['credentials'],
  setup(_props,{emit}){
    const jobs=ref<DataJob[]>([]),job=ref<DataJob>(),items=ref<NonNullable<DataReply['items']>>([]),message=ref(''),selected=ref<NonNullable<DataReply['items']>[number]>(),preview=ref<DataReply['preview']>();
    const deleteMemories=ref(false),deleteArtifacts=ref(false),packageToken=ref('');let timer:ReturnType<typeof setInterval>;
    const call=async(input:DataRequest)=>{const r=await window.desktop.data(input);if(!r.ok){message.value=r.error.message;return;}if(r.value.job)job.value=r.value.job;if(r.value.items)items.value=r.value.items;if(r.value.jobs&&!job.value)job.value=r.value.jobs.find(j=>j.kind==='delete'&&j.state!=='succeeded')??r.value.jobs[0];if(r.value.preview)preview.value=r.value.preview;return r.value;};
    const list=async()=>{const reply=await call({operation:'recycle.list'});if(reply?.jobs)jobs.value=reply.jobs;};
    onMounted(()=>{void list();timer=setInterval(()=>{if(job.value&&['waiting','copying','verifying'].includes(job.value.state))void call({operation:'backups.status',jobId:job.value.id});},500);});onUnmounted(()=>clearInterval(timer));
    const choose=async(purpose:'backup'|'package'|'restore')=>{const r=await window.desktop.selectData(purpose);if(!r.ok){message.value=r.error.message;return;}return r.value.token;};
    const backup=async()=>{const token=await choose('backup');if(token)await call({operation:'backups.create',token});};
    const preflight=async()=>{const token=await choose('package');if(token){packageToken.value=token;await call({operation:'backups.preflight',token});}};
    const restore=async()=>{const targetToken=await choose('restore');if(targetToken)await call({operation:'backups.restore',token:packageToken.value,targetToken});};
    const scope=()=>({appId:selected.value!.appId,...(selected.value!.conversationId?{conversationId:selected.value!.conversationId}:{})});
    return()=>h('section',{class:'card','data-testid':'data-settings'},[
      h('h2','备份、恢复与回收站'),h('p','备份包含尚未彻底删除的托管数据；凭据、运行时凭据目录及外部授权目录不包含。备份保留由用户手动管理，不自动删除唯一备份。'),
      h('div',{class:'actions'},[h('button',{onClick:backup},'创建一致性备份'),h('button',{onClick:preflight},'选择备份并校验'),h('button',{disabled:!packageToken.value||job.value?.state!=='succeeded',onClick:restore},'恢复到新目录')]),
      h('p','恢复影响：使用新的独立数据目录，保留原目录；不重放遗留运行。切换后请在“模型设置”重新绑定凭据，并在会话中重新授权外部目录。'),
      h('button',{onClick:()=>emit('credentials')},'打开凭据重绑设置'),
      h('label',['查看操作记录',h('select',{'aria-label':'查看数据操作记录',value:job.value?.id??'',onChange:(e:Event)=>{job.value=jobs.value.find(j=>j.id===(e.target as HTMLSelectElement).value);}},[h('option',{value:''},'选择操作'),...jobs.value.map(j=>h('option',{value:j.id},`${new Date(j.createdAt).toLocaleString()} · ${j.kind} · ${j.state}`))])]),
      job.value?h('div',{role:'status'},[h('p',`${job.value.kind} · ${job.value.state} · ${job.value.files} 文件 ${job.value.error??''}`),job.value.output?h('p',job.value.output):null,
        ['waiting','copying','verifying'].includes(job.value.state)&&job.value.kind!=='delete'?h('button',{onClick:()=>call({operation:'backups.cancel',jobId:job.value!.id})},'取消备份/恢复'):null,
        job.value.kind==='restore'&&job.value.state==='succeeded'?h('p','备份完整性及兼容性校验通过，可恢复到新目录。'):null,
        job.value.state==='ready'?h('button',{onClick:()=>call({operation:'backups.activate',jobId:job.value!.id})},'停止服务、切换并重启'):null,
        ['failed','interrupted'].includes(job.value.state)&&job.value.kind==='delete'?h('button',{onClick:()=>call({operation:'recycle.retry',jobId:job.value!.id})},'重试未完成清理'):null]):null,
      h('p','停用/归档阻止新运行；回收站保留数据并可恢复；彻底删除清理所选托管数据。外部原文件与其他应用引用的 Skill 保留。旧备份仍保留，不承诺物理介质安全擦除。'),
      h('button',{onClick:list},'刷新回收站'),...items.value.map(item=>h('button',{onClick:async()=>{selected.value=item;await call({operation:'recycle.preview',...scope()});}},item.name)),
      selected.value&&preview.value?h('div',[
        h('p',`${selected.value.name}：${preview.value.conversations} 个会话、${preview.value.attachments} 个附件、${preview.value.artifacts} 个产物、${preview.value.memories} 个记忆版本、${preview.value.sharedSkills} 个 Skill 引用。聊天与附件将清理；保留的来源记忆或产物有来源墓碑。`),
        h('label',[h('input',{type:'checkbox',checked:deleteMemories.value,onChange:(e:Event)=>deleteMemories.value=(e.target as HTMLInputElement).checked}),'同时删除来源记忆']),
        h('label',[h('input',{type:'checkbox',checked:deleteArtifacts.value,onChange:(e:Event)=>deleteArtifacts.value=(e.target as HTMLInputElement).checked}),'同时删除托管产物']),
        h('button',{onClick:async()=>{await call({operation:'recycle.restore',...scope()});await list();}},'从回收站恢复'),
        h('button',{onClick:()=>call({operation:'recycle.purge',...scope(),deleteMemories:deleteMemories.value,deleteArtifacts:deleteArtifacts.value,confirm:true})},'确认彻底删除所选数据')]):null,
      h('p',{role:'alert'},message.value),
    ]);
  },
});
