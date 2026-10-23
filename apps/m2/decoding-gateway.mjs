// Use the same stage-specific skill routing as the verified ontology run.
// Keep the complete skill snapshot for provenance, not as every call's input.
export const decodingThinking={thinking:true,reasoningEffort:'high',timeoutMs:900000};
import {retryRoundCall,parseRoundJSON,streamDropped} from './round-retry.mjs';
import {runSkillScheduleCheck} from './schedule-check.mjs';
import {createHash} from 'node:crypto';
import {readerPolicy} from './reader-quality.mjs';
export function createDecodingGateway(gateway,skill){
 const readerRules=skill.rules.split('\n--- references/reader-format.md ---\n')[1]?.split(/\n--- [^\n]+ ---\n/)[0]||'';
 return {roundConcurrency:gateway.roundConcurrency,readerPolicy:readerPolicy(readerRules),requirePlanFields:true,validateSchedule:plan=>runSkillScheduleCheck(skill.scheduleValidator,plan),generationSettings:{thinkingEnabled:true,reasoningEffort:'high',verification:'requested-not-provider-confirmed'},async complete(messages,options){
  const {task,stage=''}=JSON.parse(messages[1].content);
  // Layered rounds name their stage; older callers (re-audit) are recognised by task text.
  const global=task.startsWith('从基础资料'),audit=stage.endsWith('-check')||task.startsWith('审核完整')||task.startsWith('重新审核');
  // Product stages get the operating page first, then the method references it relies on.
  // Templates (document layouts) and the evaluation log are for chat use and maintainers, not for JSON generation.
  // Writing rules come right after the operating page so every display field is drafted to them, not fixed later.
  const order=['SKILL.md','references/reader-format.md','references/round-stages.md','references/contracts.md','references/quality-bars.md','references/method.md','references/feasibility.md'];
  const keep=new Set(order);
  const parts=skill.rules.split(/\n--- ([^\n]+) ---\n/);let rules='';
  const byPath=new Map();for(let i=1;i<parts.length;i+=2)byPath.set(parts[i],parts[i+1]);
  for(const path of order)if(byPath.has(path))rules+='\n--- '+path+' ---\n'+byPath.get(path);
  if(!rules)throw Error('技能快照格式不完整，停止生成');
  const marker=messages[0].content.indexOf('\n--- SKILL.md ---');
  const prefix=marker<0?messages[0].content:messages[0].content.slice(0,marker);
  const request=messages.map((m,i)=>i===0?{...m,content:prefix+'\n仅返回有效 JSON 对象，不加代码围栏。\n'+rules+'\n字符串数组每项写成“**短标题：**正文”，数组内不写序号，序号由界面生成。'}:m);
  const instructionSnapshot={hash:createHash('sha256').update(request[0].content).digest('hex'),skillHash:skill.hash,files:[...keep]};
  const invoke=async opts=>{
   // TokenHub closes a stream that stays silent for 60 s (2026-10-22: one unit's calls all cut at 60.0 s right after
   // the thinking block opened, while other units went through). After two such cuts the call thinks at medium,
   // which opens its answer sooner; the round records that it did.
   let dropped=0,lowered=false;
   const result=await retryRoundCall(async()=>{
    const settings=dropped>=2&&opts.reasoningEffort==='high'?(lowered||console.warn(`${stage||task.slice(0,20)}：连续 ${dropped} 次 60 秒无数据被断开，改用 medium 思考强度重试`),lowered=true,{...opts,reasoningEffort:'medium'}):opts;
    try{return await gateway.complete(request,settings);}catch(error){if(streamDropped(error))dropped++;throw error;}
   },{onRetry:options?.onRetry});
   parseRoundJSON(result.answer,{audit});
   return {...result,instructionSnapshot,...(lowered?{effortFallback:{from:'high',to:'medium',reason:'stream-silence-cut',dropsBefore:dropped}}:{})};
  };
  try{return await invoke({...options,...decodingThinking,maxTokens:global?32768:65536});}
  catch(error){
   if(!['MODEL_OUTPUT_INCOMPLETE','ROUND_JSON_INVALID'].includes(error.code))throw error;
   // One bounded recovery with identical settings for every stage; reasoning is never turned down.
   const result=await invoke({...options,...decodingThinking,maxTokens:global?32768:65536});
   return {...result,...(audit?{auditRecovery:{reason:error.diagnostics||{code:error.code},thinkingEnabled:true}}:{})};
  }
 }};
}
