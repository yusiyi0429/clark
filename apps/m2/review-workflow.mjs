export const reviewFields=[['title','标题'],['result','成果描述'],['time','时间边界'],['checks','验收标准'],['why','存在必要性'],['boundary','责任边界'],['path','核心路径'],['dependencies','约束与依赖'],['logic','核心路径'],['handoffs','交付衔接'],['parentLtoReference','对应 LTO'],['tradeoff','关键取舍'],['expectedProgress','预计长期目标推进'],['milestones','里程碑']];
export const roleGuides={
 ceo:{title:'先审阅各战场与能力域的本月成果',body:'重点看成果、验收和时间；有疑问就批注，进入领域后与 DRI 讨论。Mission 用于了解，不额外确认。',action:'开始审阅 PO'},
 dri:{title:'先核对自己的 PO，再看 Mission 组合',body:'修订自己的本月成果；检查 Mission 能否共同支撑它。对 Mission 提意见，由负责人修订。',action:'审阅我的 PO'},
 mission:{title:'先审阅自己的 Mission，再核对 Task',body:'修订成果、验收和时间，与所属领域 DRI 共同确认同一版 Mission；Task 与 Activity 由你自主规划。其他 Mission 可查看，不必全部展开。',action:'审阅我的 Mission'}
};
export function canPreviewRevise(node,role,profile){
 if(profile.member)return node.level==='po'?profile.unitDri.includes(node.id):profile.missions.some(id=>node.id===id||node.id.startsWith(id+'-'));
 if(role==='dri')return node.level==='po'&&profile.units.includes(node.id);
 if(role==='mission')return profile.missions.some(id=>node.id===id||node.id.startsWith(id+'-'));
 return false;
}
export function reviewChanges(before,after){const normalized=value=>Array.isArray(value)&&!value.length?'':value??'';return reviewFields.filter(([key])=>JSON.stringify(normalized(before[key]))!==JSON.stringify(normalized(after[key]))).map(([field,label])=>({field,label,before:before[field],after:after[field]}));}
export function draftRevision(current,patch,author){
 const changes=reviewChanges(current,{...current,...patch});
 if(!changes.length)return null;
 return {...patch,version:current.version+1,status:'修订候选',history:[...(current.history||[]),{from:current.version,to:current.version+1,author,at:new Date().toISOString(),changes}]};
}
export function applyNexusProposals(nodes,drafts,proposals){
 const next={...drafts},applied=[],skipped=[];
 for(const p of proposals||[]){const node=nodes.find(n=>n.id===p.cardId);if(!node){skipped.push(p.cardId);continue;}const current={...node,...next[node.id]};if(current.version!==p.baseVersion){skipped.push(node.id);continue;}const revision=draftRevision(current,p.patch,'Nexus');if(!revision)continue;revision.history.at(-1).sourceIds=p.sourceIds;revision.history.at(-1).reason=p.reason;next[node.id]={...next[node.id],...revision};applied.push({id:node.id,title:revision.title||current.title,version:revision.version});}
 return {drafts:next,applied,skipped};
}
