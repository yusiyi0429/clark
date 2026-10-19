// Steps on the new-round card. 2.x stages come from round-runner.mjs (PO 层 / Mission 层 / Task 层),
// 3.x stages from round-runner-v3.mjs (战场 / 能力域 / 检查与修改 / 拆 Task / 全局对齐 / 总校验 / 精简).
export const ROUND_STEPS=['读取本体','PO','Mission','Task','检查'];
export const ROUND_STEPS_V3=['读取本体','战场','能力域','拆 Task','全局对齐','总校验'];
const isV3=job=>/^3\./.test(job?.skillSnapshot?.version||'')||/^(战场|能力域|检查与修改|拆 Task|全局对齐)/.test(job?.stage||'');
export function stepsFor(job){return isV3(job)?ROUND_STEPS_V3:ROUND_STEPS;}
export function roundStep(stage='',v3=false){
 const map=v3?[[/^战场/,1],[/^(能力域|检查与修改)/,2],[/^拆 Task/,3],[/^全局对齐/,4],[/^(总校验|精简)|重新审核/,5]]:[[/^PO 层/,1],[/^Mission 层/,2],[/^Task 层/,3],[/^(总校验|精简)|重新审核/,4]];
 const layer=map.find(([re])=>re.test(stage));
 if(layer)return /完成$/.test(stage)?layer[1]+1:layer[1];
 return /续跑/.test(stage)?-1:0;
}
export function roundSteps(job){
 const steps=stepsFor(job),finished=['ready','activated'].includes(job?.status),at=finished?steps.length:job?roundStep(job.stage,isV3(job)):-1;
 const count=job?.total>1?`${job.done||0}/${job.total}`:'';
 return steps.map((label,i)=>({label,state:i<at?'done':i===at?job.status==='failed'?'stopped':'current':'todo',count:i===at?count:''}));
}
const trim=s=>String(s||'').trim().replace(/[。；;，,\s]+$/,'');
// One sentence under the steps: where the round is and what the next move means.
export function roundLine(job,round){
 if(!job)return '还没有生成过新一轮。';
 const counts=job.counts?`${job.counts.po} PO · ${job.counts.mission} Mission · ${job.counts.task} Task`:'';
 if(job.status==='running')return `正在${/^[A-Za-z]/.test(job.stage||'')?' ':''}${trim(job.stage)}${job.total>1?`（${job.done||0}/${job.total}）`:''}。期间仍显示第 ${round} 轮，可以关掉这个窗口。`;
 if(job.status==='ready')return `已生成${counts?` ${counts}`:''}，还没载入。载入后画布切到新一轮，旧轮保留。`;
 if(job.status==='activated')return `最近一次生成已载入${counts?`（${counts}）`:''}，当前显示第 ${round} 轮。`;
 const v3=isV3(job),at=roundStep(job.stage,v3),step=stepsFor(job)[at],where=!v3&&at>=1&&at<=3?`停在 ${step} 层`:step?`停在${step}`:'没有完成';
 return `${where}：${trim(job.error)||'生成中断'}。${job.canResume?'续跑沿用这次读到的资料，已完成的部分不重做。':'这次不能续跑，只能重新读取本体并生成。'}`;
}
export function roundPill(job){
 if(!job)return ['未开始','is-idle'];
 return {running:['生成中','is-running'],ready:['已生成 · 待载入','is-ready'],activated:['已载入','is-done']}[job.status]||[job.canResume?'已中断 · 可续跑':'已中断','is-failed'];
}
// Same reason for several units reads once: "2 处资料缺口：rearch、bf03 只有关联资料推断…".
export function gapSummary(gaps=[]){
 const byReason=new Map();for(const g of gaps)byReason.set(g.reason,[...(byReason.get(g.reason)||[]),g.unit]);
 return `${gaps.length} 处资料缺口：${[...byReason].map(([reason,units])=>`${units.join('、')} ${String(reason||'').replace(/[。；;\s]+$/,'')}`).join('；')}。`;
}
export function shortTime(value){
 const d=new Date(value);if(!value||Number.isNaN(d.getTime()))return value||'';
 const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
