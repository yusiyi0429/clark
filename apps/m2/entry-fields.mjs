// Entry page field values (陈溪南 2026-10-17): the skill behind what is on screen, with when it was generated,
// and the newest skill the next 重开 will use; plus the reasoning effort on the model line.
const beijing=t=>{const d=new Date(t);if(!t||Number.isNaN(d.getTime()))return '';const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(d).map(x=>[x.type,x.value]));return `${p.month}/${p.day} ${p.hour}:${p.minute}`;};
export function skillLine(data){
 const at=beijing(data.generationTiming?.finishedAt);
 return `本轮内容 ${data.skill||'未记录'}（${at?`${at} 生成`:'生成时间未记录'}）· 最新可用 ${data.availableSkill||'未记录'}（重开后使用）`;
}
// 生成模型 and 当前模型 in one line: one value when they match, both when the next round would use another.
export function modelLine(data){
 const g=data.generationModel,gen=g?.model||g?.id,effort=`推理强度 ${g?.reasoningEffort||'未记录'}`;
 const now=data.modelReady?data.modelStatus?.model:null,provider=data.modelStatus?.provider,label=`${provider?`${provider} · `:''}${now}`;
 if(!now)return gen?`本轮用 ${gen} · ${effort} · 现在待配置`:'待配置';
 const chat=data.chatModelStatus?.model&&data.chatModelStatus.model!==now?`；Nexus 和个人 Agent 用 ${data.chatModelStatus.model}`:'';
 if(!gen||gen===now)return `${label} · ${effort}${chat}`;
 return `本轮用 ${gen} · ${effort} · 现在 ${label}${chat}`;
}
// Source coverage (data from source-coverage.mjs, Ontology session): plain labels for statuses and confirmations.
export const coverageStatus={read:['已读','read'],partial:['不全','partial'],missing:['缺','missing']};
const confirmations={draft:'草稿',confirmed:'已确认',unconfirmed:'未确认','user-selected':'人工选定'};
export const confirmationLabel=v=>confirmations[v]||v||'未标注';
export function unitCounts(u){
 return [['read',u.read],['partial',u.partial],['missing',u.missing]].filter(([k,n])=>n>0||k==='read').map(([k,n])=>[k,`${coverageStatus[k][0]} ${n||0}`]);
}
export const shortDate=v=>{const m=String(v||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[2]}/${m[3]}`:'';};
// 全局对齐 (3.1+): per person, staffing questions only the CEO can settle. audit.alignDecisions = {name:{decisionsForCEO,changed}}.
export function ceoDecisions(audit){
 return Object.entries(audit?.alignDecisions||{}).flatMap(([name,d])=>(d?.decisionsForCEO||[]).map(x=>({name,text:typeof x==='string'?x:x?.question||x?.text||x?.decision||JSON.stringify(x)})));
}
