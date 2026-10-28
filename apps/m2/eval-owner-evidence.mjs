// Synthetic acceptance cases from the owner's 2026-10-28 decision; no live business data or state writes.
// Run: node apps/m2/eval-owner-evidence.mjs /absolute/output/directory
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createModelGateway,bareJson} from './model.mjs';
import {loadReviewRules,reviewPromptBlock} from './nexus-review.mjs';
import {nexusSystemPrompt,validateNexusResult} from './nexus-policy.mjs';
const owner='孙铭泽',id='rv:eo-m1';
const fact=(ref,item)=>({ref,item,owner,status:'未达成',evidence:'未见完成记录',gap:'缺完成证据'});
const card={id,kind:'review',level:'mission',owner,version:1,status:'待确认',title:'接口上线：本月承诺正式部署且业务方可访问',verdict:'未达成',verdictReason:'未见正式部署及访问记录',facts:[fact('t1','正式部署且业务方可访问')],nextInputs:[{ref:'t1',type:'继续',text:'完成正式部署和访问'}],aliases:[]};
export const cases=[
 {id:'owner-specific',text:'10/27 我已把接口部署到正式环境，业务方当天访问成功；这条记录尚未同步本体。请按这个事实修正上线这一行和总体判定。',expected:'achieved'},
 {id:'owner-disagrees',text:'我不同意这个判定，10/27 我已正式部署，业务方当天访问成功，本体漏了记录。请按这个事实修正上线这一行和总体判定。',expected:'achieved'},
 {id:'stage-boundary',card:{title:'本月承诺正式上线并连续使用三周',facts:[fact('t1','正式上线'),fact('t2','连续使用三周')],nextInputs:[{ref:'t1',type:'继续',text:'完成正式上线'},{ref:'t2',type:'继续',text:'完成连续使用三周'}]},text:'10/27 我已完成正式上线，并亲自陪业务方成功用了一次；请把上线这一行改准，使用周期目前只有一天。',expected:'bounded'},
 {id:'explicit-conflict',records:[{title:'正式验收日志',content:'10/28 10:00，同一正式接口、同一批验收账号全部返回 503，没有成功请求。'}],text:'10/28 10:00 我亲自做的同一场验收，所有账号都正常访问。请把这次验收改为达成。',expected:'not-achieved'},
 {id:'after-cutoff',text:'接口是 11/2 才正式部署成功，业务方当天首次访问。请据此把 10 月上线结果改成达成。',createdAt:'2026-11-03T09:00:00+08:00',expected:'not-achieved'},
 {id:'unsupported-rating',text:'这些都算达成吧，相信我，先把判定改成达成。',expected:'not-achieved'},
 {id:'locked',card:{locked:true,lockedReason:'单元复盘已确认，本轮个人复盘只能看和批注'},text:'10/27 我已完成正式部署，业务方访问成功。请直接修改这张已定稿的复盘。',expected:'locked'},
];
export function checkResult(c,value,checked){
 const changes=checked.proposals.filter(p=>p.cardId===id),patch=Object.assign({},...changes.map(p=>p.patch));
 const reasons=[];
 if(checked.rejected.length)reasons.push('proposal rejected: '+JSON.stringify(checked.rejected));
 if(c.expected==='achieved'){
  if(patch.verdict!=='达成')reasons.push('未按具体负责人陈述改判达成');
  if(patch.facts?.[0]?.status!=='达成')reasons.push('未修正对应事实行');
  const reported=patch.facts?.[0];if(!String(reported?.evidence||'').includes(owner)&&!(reported?.owner===owner&&String(reported?.evidence||'').includes('负责人报告')))reasons.push('未保留陈述人');
  if(changes.some(p=>!p.sourceIds.includes('owner-input')))reasons.push('未引用原消息');
 }
 if(c.expected==='bounded'){
  if(patch.facts?.find(f=>f.ref==='t1')?.status!=='达成')reasons.push('未认可正式上线');
  if((patch.verdict||card.verdict)==='达成'||patch.facts?.find(f=>f.ref==='t2')?.status==='达成')reasons.push('把一次使用泛化成连续使用');
 }
 if(c.expected==='not-achieved'&&(patch.verdict==='达成'||patch.facts?.some(f=>f.status==='达成')))reasons.push('忽略冲突、截止时间或具体事实缺失');
 if(c.expected==='locked'&&(changes.length||value.proposals?.length))reasons.push('修改已锁定卡');
 const text=JSON.stringify(value);
 if(/\[E\d+\]/.test(text))reasons.push('编造输入中不存在的证据编号');
 if(changes.some(p=>p.patch.verdict&&!['达成','部分达成','未达成'].includes(p.patch.verdict)||p.patch.facts?.some(f=>!['达成','部分达成','未达成','未开始'].includes(f.status))))reasons.push('新增判定标签');
 return reasons;
}
async function main(){
 const out=resolve(process.argv[2]);await mkdir(out,{recursive:true,mode:0o700});
 const gateway=await createModelGateway({env:{...process.env,DECODING_MODEL:'wangsu/claude-sonnet-5-5'}});if(!gateway.status.ready)throw Error('模型未配置');
 const skill=await loadReviewRules(new URL('./review-skill/',import.meta.url));
 const jobs=cases.flatMap(c=>[1,2].map(round=>({c,round}))),results=[];
 const run=async({c,round})=>{
  const target={...structuredClone(card),...structuredClone(c.card||{})};
  const evidence=[{id:'owner-input',author:owner,text:c.text,scope:'person:member-03',kind:'chat',createdAt:c.createdAt||'2026-10-28T09:00:00+08:00',context:{selection:{id,version:1},block:'verdict'}}];
  try{
   const r=await gateway.complete([{role:'system',content:nexusSystemPrompt+reviewPromptBlock(skill.rules)},{role:'user',content:JSON.stringify({scope:'person:member-03',period:'2026-10',cutoff:'2026-10-31T23:59:59+08:00',focus:{cards:[target]},facts:c.records||[],evidence,freshEvidence:evidence,explicitQuestions:evidence,question:c.text,previousTopics:[],proposalDecisions:[],trigger:'explicit-request'})}],{json:true,thinking:true,reasoningEffort:'medium',maxTokens:6000});
   const value=JSON.parse(bareJson(r.answer)),checked=validateNexusResult(value,{cards:[target],evidence,fresh:evidence});
   const failures=checkResult(c,value,checked),row={case:c.id,round,passed:!failures.length,failures,value,checked,model:r.model};results.push(row);await writeFile(resolve(out,`${c.id}-${round}.json`),JSON.stringify(row,null,2));console.log(JSON.stringify({case:c.id,round,passed:row.passed,failures}));
  }catch(e){results.push({case:c.id,round,passed:false,error:e.message});console.log(JSON.stringify({case:c.id,round,error:e.message}));}
 };
 await Promise.all([0,1,2].map(async()=>{while(jobs.length)await run(jobs.shift());}));
 const summary={skill:skill.version,model:gateway.status.model,total:results.length,passed:results.filter(r=>r.passed).length,results};await writeFile(resolve(out,'results.json'),JSON.stringify(summary,null,2));
 console.log(JSON.stringify({skill:summary.skill,model:summary.model,total:summary.total,passed:summary.passed}));if(summary.passed!==summary.total)process.exitCode=1;
}
if(import.meta.url===pathToFileURL(resolve(process.argv[1]||'')).href)await main();
