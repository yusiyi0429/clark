import {proposalRows,stripMarks} from './proposal-diff.mjs';
import {documentFieldLabel} from './document-template.mjs';
const clean=v=>stripMarks(String(v??'')).replace(/\s*\[E\d+\]/g,'');
const attribution=value=>String(value||'').match(/(?:据)?(?:负责人|本人|[\p{Script=Han}]{2,4})(?:报告|陈述|反馈|自述|说明)|自述/gu)?.join('、')||'';
const comparable=v=>Array.isArray(v)?v.map(x=>typeof x==='string'?x:JSON.stringify(x)):v&&typeof v==='object'?JSON.stringify(v):v;
const plain=v=>typeof v==='string'?clean(v):v==null?'':JSON.stringify(v);
const fields={item:'事项',owner:'负责人',status:'状态',evidence:'证据',gap:'没做到的原因'};
// Target identity is composed only from stored IDs, labels and titles; never from model text.
export function proposalTarget(proposal,node,change={}){
 const op=proposal.op,structural=!!op,object=op==='add-mission'?proposal.mission:proposal.missionSummary;
 const id=change.itemRef||(structural?proposal.missionId||object?.id:node?.id||proposal.cardId)||'';
 const title=change.itemTitle||(structural?object?.title:node?.title)||'';
 const numbered=value=>String(value||'').replace(/^rv:/,'').match(/(?:^|-)m(\d+)(?:-t(\d+))?(?:-a(\d+))?$/i);
 const match=numbered(id)||(!structural&&change.itemRef&&['mission','task','activity'].includes(node?.level)?numbered(node?.id||proposal.cardId):null);
 let scope='';
 if(match)scope=[`Mission ${Number(match[1])}`,match[2]&&`Task ${Number(match[2])}`,match[3]&&`Activity ${Number(match[3])}`].filter(Boolean).join(' · ');
 else if(structural)scope='Mission';
 else if(!change.itemRef&&!change.itemTitle){const review=String(proposal.cardId||'').startsWith('rv:');scope=node?.referenceLabel||({po:review?'PO 复盘':'PO',company:'公司复盘',mission:review?'个人复盘':'Mission',task:'Task',activity:'Activity'}[node?.level])||'';}
 return {targetLabel:[scope,title].filter(Boolean).join(' · ')||String(id)||'当前条目',targetRef:id||title};
}
function aligned(before,after,kind){
 const key=x=>String(x?.ref||x?.id||(kind==='facts'?x?.item:x?.type)||'');
 const a=new Map(),b=new Map();
 for(const [list,map]of [[before,a],[after,b]])for(const x of list){const k=key(x);if(!k||map.has(k))return null;map.set(k,x);}
 return [...new Set([...b.keys(),...a.keys()])].map(k=>[a.get(k),b.get(k)]);
}
// Stable identity first. Ambiguous arrays remain readable in full comparison but cannot become an actionable summary.
export function summaryInput(proposal,node){
 const patch=proposal.edited&&proposal.acceptedPatch?proposal.acceptedPatch:proposal.patch||{},changes=[];let ambiguous=false;
 const add=(where,before,after,oldSource='',newSource='',itemRef='',itemTitle='')=>changes.push({where,before,after,itemRef,...proposalTarget(proposal,node,{itemRef,itemTitle}),beforeSource:attribution(oldSource||plain(before)),afterSource:attribution(newSource||plain(after))});
 for(const [key,after]of Object.entries(patch)){
  if(key==='milestones'&&'logic'in patch)continue;
  const before=proposal.before?.[key],label=documentFieldLabel(node?.level,key);
  if(['facts','nextInputs'].includes(key)&&Array.isArray(after)&&(!before||Array.isArray(before))){
   const pairs=aligned(before||[],after,key);
   if(!pairs){ambiguous=true;add(label+'（条目对应不明确）',before||[],after);continue;}
   for(const [a,b]of pairs){
    if(JSON.stringify(a)===JSON.stringify(b))continue;
    const ref=b?.ref||a?.ref,related=[...(patch.facts||[]),...(proposal.before?.facts||[])].find(f=>ref&&f.ref===ref);
    const item=key==='facts'?b?.item||a?.item:related?.item||ref||b?.type||a?.type||'条目';
    const oldSource=key==='facts'?a?.evidence:'',newSource=key==='facts'?b?.evidence:'';
    if(!a||!b){add([label,item].join(' · '),a||'无此项',b||'删除此项',oldSource,newSource,ref,item);continue;}
    if(key==='facts')for(const [part,title]of Object.entries(fields)){if(plain(a[part])!==plain(b[part]))add([label,item,title].join(' · '),plain(a[part]),plain(b[part]),oldSource,newSource,ref,item);}
    else{const show=x=>`${x.type||''}：${x.text||''}${x.ask?.question?`（问 ${x.ask.to}：${x.ask.question}）`:''}`;add([label,item,b.type||a.type||'内容'].join(' · '),show(a),show(b),'','',ref,item);}
   }
  }else for(const r of proposalRows(comparable(before),comparable(after)).filter(r=>r.kind!=='same'))add(label,r.kind==='added'?'无此项':plain(r.before),r.kind==='removed'?'删除此项':plain(r.after));
 }
 if(proposal.verdictChange&&!('verdict'in patch))add('结果判定',proposal.verdictChange.from,proposal.verdictChange.to);
 if(proposal.op==='add-mission')add('新增 Mission','无此项',{mission:proposal.mission,impact:`新增1个 Mission 及其中的${Array.isArray(proposal.mission?.tasks)?proposal.mission.tasks.length:0}个 Task。`});
 if(proposal.op==='withdraw-mission')add('撤掉 Mission',{mission:proposal.missionSummary,missionId:proposal.missionId,status:'当前计划内'},{mission:proposal.missionSummary,missionId:proposal.missionId,status:'已撤掉',impact:'从当前计划移除1个 Mission 及其全部 Task；数据保留，可恢复。'});
 if(proposal.op==='restore-mission')add('恢复 Mission',{mission:proposal.missionSummary,missionId:proposal.missionId,status:'已撤掉'},{mission:proposal.missionSummary,missionId:proposal.missionId,status:'恢复到原 PO',impact:'恢复1个 Mission 及其全部 Task，确认状态与撤掉前相同。'});
 return {cardId:proposal.cardId,baseVersion:proposal.baseVersion,changes,reason:proposal.reason||'',verdictChange:proposal.verdictChange||null,ambiguous};
}

// Full source values remain available even when alignment or model compression fails.
export function completeComparison(proposal,node){
 const patch=proposal.edited&&proposal.acceptedPatch?proposal.acceptedPatch:proposal.patch||{},plain=value=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
 if(proposal.op){const input=summaryInput(proposal,node);return {changes:input.changes.map(c=>({...c,before:plain(c.before),after:plain(c.after)})),full:true,reason:proposal.reason||''};}
 return {changes:Object.entries(patch).map(([field,after])=>({where:documentFieldLabel(node?.level,field),...proposalTarget(proposal,node),before:plain(proposal.before?.[field]),after:plain(after)})),full:true,reason:proposal.reason||''};
}
export function simpleComparison(proposal,node){const input=summaryInput(proposal,node);if(input.ambiguous||input.changes.some(c=>typeof c.before!=='string'||typeof c.after!=='string'||c.before.length>32||c.after.length>38))return null;return {changes:input.changes.map(c=>({...c,before:c.before||'空白',after:c.after||'清空'})),reason:proposal.reason||''};}
