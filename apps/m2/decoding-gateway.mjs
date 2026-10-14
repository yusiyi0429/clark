// Use the same stage-specific skill routing as the verified ontology run.
// Keep the complete skill snapshot for provenance, not as every call's input.
export const decodingThinking={thinking:true,reasoningEffort:'high',timeoutMs:900000};
import {retryRoundCall,parseRoundJSON} from './round-retry.mjs';
import {runSkillScheduleCheck} from './schedule-check.mjs';
import {createHash} from 'node:crypto';
import {readerPolicy} from './reader-quality.mjs';
export function createDecodingGateway(gateway,skill){
 const readerRules=skill.rules.split('\n--- references/reader-format.md ---\n')[1]?.split(/\n--- [^\n]+ ---\n/)[0]||'';
 return {readerPolicy:readerPolicy(readerRules),requirePlanFields:true,validateSchedule:plan=>runSkillScheduleCheck(skill.scheduleValidator,plan),generationSettings:{thinkingEnabled:true,reasoningEffort:'high',verification:'requested-not-provider-confirmed'},async complete(messages,options){
  const task=JSON.parse(messages[1].content).task;
  const global=task.startsWith('从基础资料'),audit=task.startsWith('审核完整')||task.startsWith('重新审核');
  const keep=new Set(['SKILL.md','references/contracts.md','references/quality-bars.md','references/method.md','references/feasibility.md','references/reader-format.md','references/validation.md',...(!global&&!audit?['references/templates.md']:[])]);
  const parts=skill.rules.split(/\n--- ([^\n]+) ---\n/);let rules='';
  for(let i=1;i<parts.length;i+=2)if(keep.has(parts[i]))rules+='\n--- '+parts[i]+' ---\n'+(parts[i]==='references/validation.md'?parts[i+1].split('\n## 可重复行为用例')[0]:parts[i+1]);
  if(!rules)throw Error('技能快照格式不完整，停止生成');
  const marker=messages[0].content.indexOf('\n--- SKILL.md ---');
  const prefix=marker<0?messages[0].content:messages[0].content.slice(0,marker);
  const request=messages.map((m,i)=>i===0?{...m,content:prefix+'\n仅返回有效 JSON 对象，不加代码围栏。\n'+rules+(audit?'\n审核只列具体问题、影响和缺口，每项一句，不复述候选全文，不输出长分析。':'\n输出必须通过人读检查：标题不加日期、PO前缀或重复RU名称；成果只写做成后的状态，日期、验收、分工分别写回对应字段。多项验收、必要性、分工、路径、取舍、依赖用字符串数组，每项格式为“**具体短标题：**正文”，正文不加粗，数组内不写序号，由界面生成1、2、3；不拼成长段。每点只回答本字段的问题，上级Plan只摘要下级，不复制完整Card。同一条件完整写一次，其他字段仅作必要引用。PO必须填why、boundary、logic、tradeoff、dependencies、milestones及time；Mission用path而不是logic；Task不填Plan专用字段。资料未知写具体缺口和影响，无额外取舍或依赖时写简短依据，不留空也不编造。里程碑为日期加不超过10字的结果短标签，Task关联留内部，不在标签复制Task标题。不得精简掉范围、成熟程度、未知条件或承诺强度。')}:m);
  const instructionSnapshot={hash:createHash('sha256').update(request[0].content).digest('hex'),skillHash:skill.hash,files:[...keep]};
  const invoke=async opts=>{
   const result=await retryRoundCall(()=>gateway.complete(request,opts),{onRetry:options?.onRetry});
   parseRoundJSON(result.answer,{audit});
   return {...result,instructionSnapshot};
  };
  try{return await invoke({...options,...decodingThinking,maxTokens:global?32768:65536});}
  catch(error){
   if(!['MODEL_OUTPUT_INCOMPLETE','ROUND_JSON_INVALID'].includes(error.code)||!audit&&error.code!=='ROUND_JSON_INVALID')throw error;
   // One bounded recovery for an incomplete audit. Never rerun the generated units.
   const result=await invoke(audit?{...options,thinking:false,maxTokens:16384,timeoutMs:300000}:{...options,...decodingThinking,maxTokens:global?32768:65536});
   return {...result,...(audit?{auditRecovery:{reason:error.diagnostics||{code:error.code},thinkingEnabled:false}}:{})};
  }
 }};
}
