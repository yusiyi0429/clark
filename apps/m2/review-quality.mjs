import {reviewDependencyPool} from './review-dependencies.mjs';
import {fallbackEligible,reviewModelApi,REVIEW_BODY_LIMIT_BYTES} from './review-model-fallback.mjs';
import {reviewModelRequestBody} from './review-source-plan.mjs';
import {createHash} from 'node:crypto';
import {bareJson} from './model.mjs';

export const qualityHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
const abort=signal=>signal?.throwIfAborted();
const DEFERRED=Symbol('review-action-deferred');
export const deferReviewAction=detail=>({[DEFERRED]:detail});
export const GPT_REPAIR_TIME_BUDGET=Object.freeze({attemptMs:150000,totalMs:330000});
export const isReviewResourceLimit=error=>['REVIEW_REPAIR_TIME_BUDGET','REVIEW_PACKET_OVERSIZE','REVIEW_MODEL_ATTEMPT_LIMIT','REVIEW_SOURCE_REQUEST_BUDGET','REVIEW_SOURCE_CONTEXT_PENDING','REVIEW_SOURCE_REQUEST_REPEAT','REVIEW_SOURCE_REQUEST_CONTRACT','MODEL_REFUSAL','MODEL_OUTPUT_CONTRACT','MODEL_OUTPUT_INCOMPLETE'].includes(error?.code)||error?.reviewOutputContract===true||error?.name==='TimeoutError'||!!error?.providerStatus;
// Cache only verified answers. Every attempt (including malformed output) is
// retained, independently of the two-per-card semantic revision budget.
export async function qualityModelCall({gateway,system,quality,run,pass,stage,ref='',payload,validate=x=>x,save,signal,maxBodyBytes=REVIEW_BODY_LIMIT_BYTES,maxTokens=32000,reasoningEffort='high',now=()=>performance.now()}){
 if(maxTokens!==32000&&!(stage==='check'&&maxTokens===64000))throw Error('仅完整检查允许64k输出预算，初稿与修订保持32k');
 if(reasoningEffort!=='high'&&!(stage==='check'&&reasoningEffort==='medium'))throw Error('仅完整检查允许medium推理');
 const callOptions={json:true,thinking:true,reasoningEffort,maxTokens},optionIdentity=maxTokens===32000&&reasoningEffort==='high'?{}:{callOptions};
 const model=gateway.status?.model||null,backups=gateway.reviewFallbacks||[],fallbackModels=backups.map(g=>g.status.model),policy=backups.length?{fallbackModels}:{};
 const inputHash=qualityHash({system,payload,model,...policy,...optionIdentity}),key=`quality-${pass}-${stage}-${ref}-${inputHash}`;
 let request=quality.requests[key];
 const verifyRequest=()=>{if(request&&(request.inputHash!==inputHash||request.model!==model||qualityHash(request.fallbackModels||[])!==qualityHash(fallbackModels)||qualityHash({system,payload:request.payload,model,...policy,...(request.callOptions?{callOptions:request.callOptions}:{})})!==inputHash||request.sourceHash!==quality.sourceHash||request.skillHash!==quality.skillHash||request.pass!==pass||request.stage!==stage||request.ref!==ref||request.attempts.some(a=>a.options?.maxTokens!==maxTokens||a.options?.thinking!==true||a.options?.reasoningEffort!==reasoningEffort||a.options?.json!==true)))throw Error('质量检查缓存输入或保存的请求已变化');};
 abort(signal);verifyRequest();
 if(request?.status==='done'){
  if(backups.length&&(![model,...fallbackModels].includes(request.selectedAlias)||request.attempts.at(-1)?.requestedAlias!==request.selectedAlias||request.returnedModel!==request.attempts.at(-1)?.returnedModel||request.actualApi!==reviewModelApi(request.selectedAlias)))throw Error('备用模型缓存来源与真实调用记录不一致');
  if(qualityHash(run.raw[key])!==request.outputHash)throw Error('质量检查缓存原答校验失败');
  return validate(JSON.parse(bareJson(run.raw[key])));
 }
 request??=quality.requests[key]={inputHash,model,...policy,...optionIdentity,sourceHash:quality.sourceHash,skillHash:quality.skillHash,pass,stage,ref,payload:clone(payload),attempts:[]};
 const route=new Map([[model,gateway],...backups.map(g=>[g.status.model,g])]);
 const groupedRepair=/^(?:revise|refresh)(?:-source)?$/.test(stage)&&payload.unit?.id&&Number.isInteger(payload.revision);
 const timeBudget=groupedRepair?run.outputPolicy?.gptRepairTimeBudget:undefined;
 if(timeBudget&&qualityHash(timeBudget)!==qualityHash(GPT_REPAIR_TIME_BUDGET))throw Error('GPT 修订时限合同不受支持');
 const groupedCheck=stage==='check'&&['impact','final'].includes(payload.phase)&&['first','last'].includes(payload.sourceRound)&&typeof payload.candidateHash==='string';
 const grouped=groupedRepair||groupedCheck;
 const sameAction=r=>r.pass===pass&&r.payload?.candidateHash===payload.candidateHash&&r.sourceHash===quality.sourceHash&&r.skillHash===quality.skillHash&&
  (groupedCheck?r.stage==='check'&&r.payload.phase===payload.phase&&['first','last'].includes(r.payload.sourceRound):
   /^(?:revise|refresh)(?:-source)?$/.test(r.stage)&&r.payload?.unit?.id===payload.unit.id&&r.payload?.revision===payload.revision);
 const history=grouped?Object.values(quality.requests).filter(sameAction).flatMap(r=>r.attempts).sort(groupedCheck?(a,b)=>a.attempt-b.attempt:(a,b)=>String(a.at).localeCompare(String(b.at))):request.attempts;
 const last=history.at(-1);let prior=last;
 let active=backups.length||grouped?route.get(last?.nextModel||last?.requestedModel||model):gateway;
 if(!active)throw Error('备用模型续跑来源不属于已授权策略');
 const used=history.length;
 if(used>=3)throw Object.assign(Error(groupedCheck?'同一检查的模型、补源及重试尝试已用完，保留未核候选':'同一修订的模型、补源及重试尝试已用完，保留未核候选'),{code:'REVIEW_MODEL_ATTEMPT_LIMIT'});
 if(grouped)request.attemptGroup={pass,...(groupedCheck?{phase:payload.phase}:{ref:payload.unit.id,revision:payload.revision}),candidateHash:payload.candidateHash};
 request.status='running';await save(run);
 for(let attempt=used+1;attempt<=3;attempt++){
  abort(signal);verifyRequest();
  const timed=timeBudget&&active.status?.model==='wangsu/gpt-6.1-sol';
  const spent=timed?history.reduce((sum,entry)=>sum+(entry.timeBudget?.elapsedMs??entry.timeBudget?.reservedMs??0),0):0;
  const timeoutMs=timed?Math.min(timeBudget.attemptMs,timeBudget.totalMs-spent):900000;
  if(timeoutMs<=0)throw Object.assign(Error('本卡 GPT 修订及补源时间已用完，保留待核候选'),{code:'REVIEW_REPAIR_TIME_BUDGET'});
  const record={attempt,at:new Date().toISOString(),requestedModel:active.status?.model||null,requestedAlias:active.status?.model||null,api:reviewModelApi(active.status?.model),options:clone(callOptions),switchFrom:prior?.switchFrom||null,switchReason:prior?.switchReason||null};if(timed)record.timeBudget={reservedMs:timeoutMs};request.attempts.push(record);if(grouped)history.push(record);await save(run);
  verifyRequest();
  let answer,error,parsed,started;
  try{
   const correction=payload.checkBasis===2&&request.attempts.at(-2)?.outputContract?request.attempts.at(-2).error:null;
   const attemptSystem=correction?system+'\n上一次响应未通过结构校验：'+correction+'。按当前请求合同重新核验并返回完整 JSON。不要补造来源或改变证据。':system;
   if(correction)record.validationFeedback=correction;
   if(backups.length||grouped&&quality.qualityFallback||correction){const actual=Buffer.byteLength(JSON.stringify(reviewModelRequestBody(attemptSystem,request.payload,{model:active.status.model,...record.options})));if(actual>maxBodyBytes)throw Object.assign(Error('实际模型完整请求体超过本次工程预算，未调用'),{code:'REVIEW_PACKET_OVERSIZE',actual});record.bodyBytes=actual;record.bodyBudgetBytes=maxBodyBytes;}
   const attemptSignal=timed?AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]):signal;
   if(timed)started=now();
   answer=await active.complete([{role:'system',content:attemptSystem},{role:'user',content:JSON.stringify(request.payload)}],{...callOptions,timeoutMs,signal:attemptSignal,...(timed?{onTransportTiming:timing=>{record.transportTiming=timing;}}:{}),trace:{name:key,stage,metadata:{ref,pass,inputHash,sourceHash:quality.sourceHash,maxTokens}}});
   record.raw=answer.rawAnswer??answer.answer;record.usage=answer.usage;record.gatewayModel=answer.model||null;record.returnedModel=answer.returnedModel??null;record.providerRequestId=answer.providerRequestId||null;record.finishReason=answer.finishReason||null;record.finishReasonSource=answer.finishReasonSource||null;
   if(timed)attemptSignal.throwIfAborted();
   try{parsed=validate(JSON.parse(bareJson(answer.answer)));}catch(error){error.reviewOutputContract=true;throw error;}
  }catch(e){error=e;if(payload.checkBasis===2&&e.reviewOutputContract)record.outputContract=true;record.error=String(e.message);record.errorCode=e.code||null;record.raw??=e.rawAnswer??e.partialAnswer??null;record.providerRequestId??=e.providerRequestId||null;record.returnedModel??=e.diagnostics?.returnedModel??null;record.finishReason??=e.diagnostics?.providerFinishReason||e.diagnostics?.finishReason||null;record.finishReasonSource??=e.diagnostics?.finishReasonSource||null;record.finishedAt=new Date().toISOString();}
  if(timed)record.timeBudget.elapsedMs=started===undefined?0:Math.max(0,Math.ceil(now()-started));
  if(!error){run.raw[key]=answer.answer;request.outputHash=qualityHash(answer.answer);request.status='done';request.selectedAlias=record.requestedAlias;request.returnedModel=record.returnedModel;request.actualApi=record.api;record.finishedAt=new Date().toISOString();await save(run);return parsed;}
  let switched=false;
  if(!signal?.aborted&&attempt<3&&backups.length&&active===gateway&&fallbackEligible(error)){record.nextModel=backups[0].status.model;record.switchFrom=active.status.model;record.switchReason={code:error.code||null,message:String(error.message),providerStatus:error.providerStatus||null,outputContract:error.reviewOutputContract===true};active=backups[0];switched=true;}
  request.status='failed';await save(run);prior=record;
  if(attempt===3&&!signal?.aborted&&fallbackEligible(error)&&error.code!=='REVIEW_JOURNAL_UNAVAILABLE')throw Object.assign(new Error('模型尝试已用完，原候选保留未核：'+String(error.message),{cause:error}),{code:'REVIEW_MODEL_ATTEMPT_LIMIT',attempts:attempt,lastFailure:{code:error.code||error.cause?.code||null,message:String(error.message),providerStatus:error.providerStatus||null}});
  if(signal?.aborted||error.code==='REVIEW_PACKET_OVERSIZE'||!switched&&(error.code==='MODEL_REFUSAL'||error.diagnostics?.finishReason==='refusal')||attempt===3)throw error;
 }
}

const reviewRef=ref=>String(ref||'').replace(/^rv:/,'');
function changedChildVerdicts(ref,children,before,after){
 const rows=after[ref]?.facts||[];
 return children.flatMap(child=>{
  const oldVerdict=before[child]?.verdict,newVerdict=after[child]?.verdict;
  if(!oldVerdict||!newVerdict||oldVerdict===newVerdict)return [];
  const matches=rows.filter(row=>reviewRef(row.ref)===reviewRef(child));
  if(matches.length!==1||matches[0].status!==oldVerdict)return [];
  return [{ref,type:'程序检查',problem:`直接引用的子复盘 ${child} 判定已由「${oldVerdict}」改为「${newVerdict}」，本层事实行仍引用旧判定`,impact:'本轮上下级状态不一致',mustFix:true,fixable:true,sourceRefs:[ref,child],dependencyChange:{ref:child,oldVerdict,newVerdict}}];
 });
}

// Each card shares one budget for semantic edits, structural repairs and
// dependency refreshes. A resume continues the same pass and the same counters.
export async function runReviewQuality({run,input,skill,sources,check,revise,problems=()=>[],normalize=()=>{},save=async()=>{},onProgress=async()=>{},signal,revisionConcurrency=8,phased=false}){
 if(!Number.isInteger(revisionConcurrency)||revisionConcurrency<1||revisionConcurrency>20)throw Error('修订并发必须在1到20之间');
 const max=skill.maxRevisionRounds;if(max!==2)throw Error('自动修订合同必须明确最多 2 轮');
 const inputHash=qualityHash(input),sourceHash=qualityHash(sources),skillHash=skill.hash;
 let q=run.quality;
 if(q&&(q.inputHash!==inputHash||q.sourceHash!==sourceHash||q.skillHash!==skillHash||q.maxRevisions!==max))throw Error('质量续跑来源、技能或修订上限已变化');
 if(!q){normalize();q=run.quality={schemaVersion:1,inputHash,sourceHash,skillHash,maxRevisions:max,counts:{},requests:{},passes:[],status:'checking',candidateHash:qualityHash(run.reviews),...(phased?{checkFlow:1}:{})};await save(run);}
 if((q.checkFlow===1)!==phased)throw Error('复查阶段合同已变化');
 if(q.candidateHash!==qualityHash(run.reviews))throw Error('质量续跑候选已变化，不能复用旧检查');
 const items=input.stages.flat(),byId=new Map(items.map(c=>[c.id,c]));
 const childrenOf=ref=>[...new Set([...(byId.get(ref)?.children||[]),...items.filter(c=>c.parent===ref).map(c=>c.id)])];
 const verifyAction=action=>{for(const ref of [action.ref,...childrenOf(action.ref)])if(qualityHash(action.before?.[ref])!==qualityHash(run.reviews[ref]))throw Error('质量修订相关对象或子项输入校验失败：'+ref);};
 const verifyPass=pass=>{
  if(pass.sourceHash!==sourceHash||pass.reviewHash!==qualityHash(pass.reviews))throw Error('质量检查前快照校验失败');
  if(phased){
   const previous=q.passes[pass.index-1],phase=!previous?'initial':previous.actions?.length?'impact':'final';
   if(q.passes[pass.index]!==pass||pass.phase!==phase)throw Error('质量检查阶段顺序校验失败');
   if(pass.coverageHash&&(pass.coverageHash!==qualityHash(pass.coverage)||pass.coverage.candidateHash!==pass.reviewHash))throw Error('质量检查覆盖回执已变化');
  }
  if(pass.issuesHash&&pass.issuesHash!==qualityHash({issues:pass.issues,structural:pass.structural}))throw Error('质量检查问题快照校验失败');
  if(pass.actionsHash&&pass.actionsHash!==qualityHash(pass.actions.map(({ref,issues,refresh})=>({ref,issues,refresh}))))throw Error('质量修订动作快照校验失败');
  for(const action of pass.actions||[]){
   if((action.status==='done'||action.before)&&!action.reserved)throw Error('质量修订预算预占校验失败');
   if(action.before&&action.beforeHash!==qualityHash(action.before))throw Error('质量修订前快照校验失败');
   if(action.before&&!['done','deferred'].includes(action.status))verifyAction(action);
   if(pass.status==='revising'&&action.status==='done'&&action.afterHash!==qualityHash(run.reviews[action.ref]))throw Error('质量修订后快照校验失败');
  }
 };
 const counts={};for(const pass of q.passes){verifyPass(pass);for(const action of pass.actions||[])if(action.reserved){const n=(counts[action.ref]||0)+1;if(action.revision!==n||n>max)throw Error('质量修订次数校验失败');counts[action.ref]=n;}}
 const entries=value=>Object.entries(value).sort(([a],[b])=>a.localeCompare(b));
 if(qualityHash(entries(counts))!==qualityHash(entries(q.counts)))throw Error('质量修订累计次数校验失败');
 if(phased&&q.passes.filter(pass=>pass.actions?.length).length>max)throw Error('整轮修订批次校验失败');
 if(phased&&q.status==='passed'){
  const final=q.passes.at(-1);
  if(final?.phase!=='final'||final.status!=='done'||final.reviewHash!==q.candidateHash||!final.coverageHash)throw Error('缺少当前候选的末检覆盖回执');
 }
 if(['passed','blocked','needs-review'].includes(q.status))return run;
 const parents=new Map();for(const c of items){if(c.parent)parents.set(c.id,c.parent);for(const id of c.children||[])parents.set(id,c.id);}
 const required=x=>x.mustFix===true||skill.mustFix.includes(x.type);
 try{for(;;){
  abort(signal);
  let pass=q.passes.at(-1);
  if(!pass||pass.status==='done'){
   const phase=!pass?'initial':pass.actions?.length?'impact':'final';
   pass={index:q.passes.length,...(phased?{phase}:{}),status:'checking',reviews:clone(run.reviews),reviewHash:qualityHash(run.reviews),sourceHash,at:new Date().toISOString()};q.passes.push(pass);q.status='checking';await save(run);
  }
  verifyPass(pass);
  if(pass.status==='checking'){
   await onProgress({stage:phased?{initial:'完整质量首检',impact:'修订影响复查',final:'整轮一致性末检'}[pass.phase]:`质量复查 ${pass.index+1}`,qualityPass:pass.index});
   let issues;try{issues=await check(pass.reviews,pass.index,q);}catch(error){if(!signal?.aborted&&isReviewResourceLimit(error)){q.status='needs-review';q.blockReason='本轮复查未完成，保留原候选与未核事项';q.verificationPending=[{unit:'global',code:error.code||'CHECK_UNVERIFIED',problem:String(error.message),...(error.lastFailure?{lastFailure:clone(error.lastFailure)}:{}),checks:error.checks||[]}];pass.status='needs-review';await save(run);return run;}throw error;}abort(signal);verifyPass(pass);
   if(phased&&pass.reviewHash!==qualityHash(run.reviews))throw Error('检查期间候选已变化，不能使用旧结论');
   const structural=problems({reviews:pass.reviews});
   pass.issues=clone(issues);pass.structural=clone(structural);pass.issuesHash=qualityHash({issues:pass.issues,structural:pass.structural});run.issues=clone(issues);
   const critical=issues.filter(required),fixable=critical.filter(x=>x.fixable!==false);
   q.remaining=[...critical.map(x=>({unit:x.ref,title:byId.get(x.ref)?.title,...x})),...structural.map(x=>({...x,title:byId.get(x.unit)?.title}))];
   if(phased&&!pass.coverageHash)throw Error('缺少当前候选的检查覆盖回执');
   if(!q.remaining.length){pass.status='done';if(phased&&pass.phase!=='final'){await save(run);continue;}q.status='passed';await save(run);return run;}
   const perRef=new Map();
   for(const issue of fixable){const list=perRef.get(issue.ref)||[];list.push(issue);perRef.set(issue.ref,list);}
   for(const issue of structural){const list=perRef.get(issue.unit)||[];list.push({...issue,type:'程序检查',mustFix:true,fixable:true});perRef.set(issue.unit,list);}
   if(!perRef.size){q.status='blocked';q.blockReason='仍有无法据现有来源修复的关键问题';await save(run);return run;}
   const refresh=new Set();if(!phased)for(const ref of perRef.keys()){let parent=parents.get(ref);const seen=new Set();while(parent&&!seen.has(parent)){seen.add(parent);if(byId.has(parent)){refresh.add(parent);parent=parents.get(parent);}else break;}}
   const refs=new Set([...perRef.keys(),...refresh]);
   const unavailable=[...refs].filter(ref=>!byId.has(ref)||(q.counts[ref]||0)>=max);
   if(phased&&q.passes.filter(p=>p.actions?.length).length>=max)unavailable.push(...[...refs].filter(ref=>!unavailable.includes(ref)));
   if(unavailable.length){q.status='blocked';q.blockReason='以下复盘已到两轮自动修订上限：'+unavailable.map(ref=>byId.get(ref)?.title||ref).join('、');q.remaining.push(...unavailable.map(unit=>({unit,title:byId.get(unit)?.title,problem:'已到两轮自动修订上限，保留草稿等待人工处理'})));await save(run);return run;}
   pass.actions=items.filter(c=>refs.has(c.id)).map(c=>({ref:c.id,issues:clone(perRef.get(c.id)||[]),refresh:refresh.has(c.id),status:'pending'}));
   pass.actionsHash=qualityHash(pass.actions.map(({ref,issues,refresh})=>({ref,issues,refresh})));
   pass.status='revising';q.status='revising';await save(run);
  }
  // Resume each original request, and release a slot as soon as its own
  // branch finishes. Parent inputs never wait for unrelated branches.
  const actionByRef=new Map(pass.actions.map(action=>[action.ref,action]));
  const defer=async(action,detail)=>{action.status='deferred';action.deferred=clone(detail);await save(run);};
  const pending=phased?items.map(card=>({id:card.id})):pass.actions.filter(action=>!['done','deferred'].includes(action.status)).map(action=>({id:action.ref})).reverse();
  await reviewDependencyPool({items:pending,concurrency:revisionConcurrency,signal,
   dependencies:node=>childrenOf(node.id),execute:async({id})=>{
    let action=actionByRef.get(id);
    if(action&&['done','deferred'].includes(action.status))return;
    if(phased&&!action?.before){
     const linked=changedChildVerdicts(id,childrenOf(id),pass.reviews,run.reviews);
     if(linked.length){
      if(!action){action={ref:id,issues:[],refresh:false,status:'pending'};pass.actions.push(action);actionByRef.set(id,action);}
      if(!action.issues.some(issue=>issue.dependencyChange))action.issues.push(...linked);
      pass.actionsHash=qualityHash(pass.actions.map(({ref,issues,refresh})=>({ref,issues,refresh})));
      if((q.counts[id]||0)>=max){await defer(action,{code:'DEPENDENCY_REVISION_LIMIT',problem:'直接引用已失效，本卡修订额度已用完'});return;}
     }
    }
    if(!action)return;
    abort(signal);
    const blocked=childrenOf(action.ref).filter(ref=>actionByRef.get(ref)?.status==='deferred');
    if(blocked.length){await defer(action,{code:'DEPENDENCY_UNVERIFIED',problem:'下级尚未核验，本层候选保留原文，待同步',refs:blocked});return;}
    if(!action.reserved){q.counts[action.ref]=(q.counts[action.ref]||0)+1;action.reserved=true;action.revision=q.counts[action.ref];}
    if(!action.before){action.before=clone(run.reviews);action.beforeHash=qualityHash(action.before);}
    verifyAction(action);action.status='running';await save(run);
    await onProgress({stage:`自动修订第 ${action.revision} 轮`,qualityPass:pass.index});
    try{
     const review=await revise(byId.get(action.ref),action,pass.index,q);abort(signal);verifyAction(action);
     if(review?.[DEFERRED]){await defer(action,review[DEFERRED]);return;}
     if(!review||typeof review!=='object'||Array.isArray(review))throw Object.assign(Error('修订未返回复盘对象，原候选保留'),{code:'MODEL_OUTPUT_CONTRACT'});
     run.reviews[action.ref]=review;action.status='done';action.afterHash=qualityHash(review);q.candidateHash=qualityHash(run.reviews);await save(run);
    }catch(error){if(!signal?.aborted&&isReviewResourceLimit(error)){await defer(action,{code:error.code||'MODEL_UNVERIFIED',problem:String(error.message),...(error.lastFailure?{lastFailure:clone(error.lastFailure)}:{}),checks:error.checks||[]});return;}throw error;}
   }});
  if(pass.actions.some(action=>action.status==='deferred')){
   q.verificationPending=pass.actions.filter(action=>action.status==='deferred').map(action=>({unit:action.ref,title:byId.get(action.ref)?.title,...clone(action.deferred)}));
   q.status='needs-review';q.blockReason='自动处理结束，仍有未核事项；修订后尚未完成最终复查，保留独立候选';pass.status='needs-review';q.candidateHash=qualityHash(run.reviews);await save(run);return run;
  }
  normalize();q.candidateHash=qualityHash(run.reviews);pass.status='done';q.status='checking';await save(run);
 }}catch(error){q.status='waiting';q.error=String(error.message);await save(run);throw error;}
}
