import {fallbackEligible,reviewModelApi,REVIEW_BODY_LIMIT_BYTES} from './review-model-fallback.mjs';
import {reviewModelRequestBody} from './review-source-plan.mjs';
import {createHash} from 'node:crypto';
import {bareJson} from './model.mjs';

export const qualityHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
const abort=signal=>signal?.throwIfAborted();
// Cache only verified answers. Every attempt (including malformed output) is
// retained, independently of the two-per-card semantic revision budget.
export async function qualityModelCall({gateway,system,quality,run,pass,stage,ref='',payload,validate=x=>x,save,signal,maxBodyBytes=REVIEW_BODY_LIMIT_BYTES}){
 const model=gateway.status?.model||null,backups=gateway.reviewFallbacks||[],fallbackModels=backups.map(g=>g.status.model),policy=backups.length?{fallbackModels}:{};
 const inputHash=qualityHash({system,payload,model,...policy}),key=`quality-${pass}-${stage}-${ref}-${inputHash}`;
 let request=quality.requests[key];
 const verifyRequest=()=>{if(request&&(request.inputHash!==inputHash||request.model!==model||qualityHash(request.fallbackModels||[])!==qualityHash(fallbackModels)||qualityHash({system,payload:request.payload,model,...policy})!==inputHash||request.sourceHash!==quality.sourceHash||request.skillHash!==quality.skillHash||request.pass!==pass||request.stage!==stage||request.ref!==ref))throw Error('质量检查缓存输入或保存的请求已变化');};
 abort(signal);verifyRequest();
 if(request?.status==='done'){
  if(backups.length&&(![model,...fallbackModels].includes(request.selectedAlias)||request.attempts.at(-1)?.requestedAlias!==request.selectedAlias||request.returnedModel!==request.attempts.at(-1)?.returnedModel||request.actualApi!==reviewModelApi(request.selectedAlias)))throw Error('备用模型缓存来源与真实调用记录不一致');
  if(qualityHash(run.raw[key])!==request.outputHash)throw Error('质量检查缓存原答校验失败');
  return validate(JSON.parse(bareJson(run.raw[key])));
 }
 request??=quality.requests[key]={inputHash,model,...policy,sourceHash:quality.sourceHash,skillHash:quality.skillHash,pass,stage,ref,payload:clone(payload),attempts:[]};
 const route=new Map([[model,gateway],...backups.map(g=>[g.status.model,g])]);
 let active=backups.length?route.get(request.attempts.at(-1)?.nextModel||request.attempts.at(-1)?.requestedModel||model):gateway;
 if(!active)throw Error('备用模型续跑来源不属于已授权策略');
 const used=backups.length?request.attempts.length:0;
 if(used>=3)throw Object.assign(Error('同一逻辑请求三个模型尝试已用完，保留草稿'),{code:'REVIEW_MODEL_ATTEMPT_LIMIT'});
 request.status='running';await save(run);
 for(let attempt=used+1;attempt<=3;attempt++){
  abort(signal);verifyRequest();const record={attempt,at:new Date().toISOString(),requestedModel:active.status?.model||null,requestedAlias:active.status?.model||null,api:reviewModelApi(active.status?.model),options:{json:true,thinking:true,reasoningEffort:'high',maxTokens:32000},switchFrom:request.attempts.at(-1)?.switchFrom||null,switchReason:request.attempts.at(-1)?.switchReason||null};request.attempts.push(record);await save(run);
  verifyRequest();
  let answer,error,parsed;
  try{
   if(backups.length){const actual=Buffer.byteLength(JSON.stringify(reviewModelRequestBody(system,request.payload,{model:active.status.model,...record.options})));if(actual>maxBodyBytes)throw Object.assign(Error('实际模型完整请求体超过本次工程预算，未调用'),{code:'REVIEW_PACKET_OVERSIZE',actual});record.bodyBytes=actual;record.bodyBudgetBytes=maxBodyBytes;}
   answer=await active.complete([{role:'system',content:system},{role:'user',content:JSON.stringify(request.payload)}],{json:true,thinking:true,reasoningEffort:'high',maxTokens:32000,timeoutMs:900000,signal,trace:{name:key,stage,metadata:{ref,pass,inputHash,sourceHash:quality.sourceHash}}});
   record.raw=answer.rawAnswer??answer.answer;record.usage=answer.usage;record.gatewayModel=answer.model||null;record.returnedModel=answer.returnedModel??null;record.providerRequestId=answer.providerRequestId||null;record.finishReason=answer.finishReason||null;record.finishReasonSource=answer.finishReasonSource||null;
   try{parsed=validate(JSON.parse(bareJson(answer.answer)));}catch(error){error.reviewOutputContract=true;throw error;}
  }catch(e){error=e;record.error=String(e.message);record.errorCode=e.code||null;record.raw??=e.rawAnswer??e.partialAnswer??null;record.providerRequestId??=e.providerRequestId||null;record.returnedModel??=e.diagnostics?.returnedModel??null;record.finishReason??=e.diagnostics?.providerFinishReason||e.diagnostics?.finishReason||null;record.finishReasonSource??=e.diagnostics?.finishReasonSource||null;record.finishedAt=new Date().toISOString();}
  if(!error){run.raw[key]=answer.answer;request.outputHash=qualityHash(answer.answer);request.status='done';request.selectedAlias=record.requestedAlias;request.returnedModel=record.returnedModel;request.actualApi=record.api;record.finishedAt=new Date().toISOString();await save(run);return parsed;}
  let switched=false;
  if(!signal?.aborted&&attempt<3&&backups.length&&active===gateway&&fallbackEligible(error)){record.nextModel=backups[0].status.model;record.switchFrom=active.status.model;record.switchReason={code:error.code||null,message:String(error.message),providerStatus:error.providerStatus||null,outputContract:error.reviewOutputContract===true};active=backups[0];switched=true;}
  request.status='failed';await save(run);
  if(signal?.aborted||error.code==='REVIEW_PACKET_OVERSIZE'||!switched&&(error.code==='MODEL_REFUSAL'||error.diagnostics?.finishReason==='refusal')||attempt===3)throw error;
 }
}

// Each card shares one budget for semantic edits, structural repairs and
// dependency refreshes. A resume continues the same pass and the same counters.
export async function runReviewQuality({run,input,skill,sources,check,revise,problems=()=>[],normalize=()=>{},save=async()=>{},onProgress=async()=>{},signal}){
 const max=skill.maxRevisionRounds;if(max!==2)throw Error('自动修订合同必须明确最多 2 轮');
 const inputHash=qualityHash(input),sourceHash=qualityHash(sources),skillHash=skill.hash;
 let q=run.quality;
 if(q&&(q.inputHash!==inputHash||q.sourceHash!==sourceHash||q.skillHash!==skillHash||q.maxRevisions!==max))throw Error('质量续跑来源、技能或修订上限已变化');
 if(!q){normalize();q=run.quality={schemaVersion:1,inputHash,sourceHash,skillHash,maxRevisions:max,counts:{},requests:{},passes:[],status:'checking',candidateHash:qualityHash(run.reviews)};await save(run);}
 if(q.candidateHash!==qualityHash(run.reviews))throw Error('质量续跑候选已变化，不能复用旧检查');
 const verifyPass=pass=>{
  if(pass.sourceHash!==sourceHash||pass.reviewHash!==qualityHash(pass.reviews))throw Error('质量检查前快照校验失败');
  if(pass.issuesHash&&pass.issuesHash!==qualityHash({issues:pass.issues,structural:pass.structural}))throw Error('质量检查问题快照校验失败');
  if(pass.actionsHash&&pass.actionsHash!==qualityHash(pass.actions.map(({ref,issues,refresh})=>({ref,issues,refresh}))))throw Error('质量修订动作快照校验失败');
  for(const action of pass.actions||[]){
   if((action.status==='done'||action.before)&&!action.reserved)throw Error('质量修订预算预占校验失败');
   if(action.before&&(action.beforeHash!==qualityHash(action.before)||action.status!=='done'&&action.beforeHash!==qualityHash(run.reviews)))throw Error('质量修订前快照校验失败');
   if(pass.status==='revising'&&action.status==='done'&&action.afterHash!==qualityHash(run.reviews[action.ref]))throw Error('质量修订后快照校验失败');
  }
 };
 const counts={};for(const pass of q.passes){verifyPass(pass);for(const action of pass.actions||[])if(action.reserved){const n=(counts[action.ref]||0)+1;if(action.revision!==n||n>max)throw Error('质量修订次数校验失败');counts[action.ref]=n;}}
 const entries=value=>Object.entries(value).sort(([a],[b])=>a.localeCompare(b));
 if(qualityHash(entries(counts))!==qualityHash(entries(q.counts)))throw Error('质量修订累计次数校验失败');
 if(q.status==='passed'||q.status==='blocked')return run;
 const items=input.stages.flat(),byId=new Map(items.map(c=>[c.id,c]));
 const parents=new Map();for(const c of items){if(c.parent)parents.set(c.id,c.parent);for(const id of c.children||[])parents.set(id,c.id);}
 const required=x=>x.mustFix===true||skill.mustFix.includes(x.type);
 try{for(;;){
  abort(signal);
  let pass=q.passes.at(-1);
  if(!pass||pass.status==='done'){
   pass={index:q.passes.length,status:'checking',reviews:clone(run.reviews),reviewHash:qualityHash(run.reviews),sourceHash,at:new Date().toISOString()};q.passes.push(pass);q.status='checking';await save(run);
  }
  verifyPass(pass);
  if(pass.status==='checking'){
   await onProgress({stage:`质量复查 ${pass.index+1}`,qualityPass:pass.index});
   const issues=await check(pass.reviews,pass.index,q);abort(signal);verifyPass(pass);
   const structural=problems({reviews:pass.reviews});
   pass.issues=clone(issues);pass.structural=clone(structural);pass.issuesHash=qualityHash({issues:pass.issues,structural:pass.structural});run.issues=clone(issues);
   const critical=issues.filter(required),fixable=critical.filter(x=>x.fixable!==false);
   q.remaining=[...critical.map(x=>({unit:x.ref,title:byId.get(x.ref)?.title,...x})),...structural.map(x=>({...x,title:byId.get(x.unit)?.title}))];
   if(!q.remaining.length){pass.status='done';q.status='passed';await save(run);return run;}
   const perRef=new Map();
   for(const issue of fixable){const list=perRef.get(issue.ref)||[];list.push(issue);perRef.set(issue.ref,list);}
   for(const issue of structural){const list=perRef.get(issue.unit)||[];list.push({...issue,type:'程序检查',mustFix:true,fixable:true});perRef.set(issue.unit,list);}
   if(!perRef.size){q.status='blocked';q.blockReason='仍有无法据现有来源修复的关键问题';await save(run);return run;}
   const refresh=new Set();for(const ref of perRef.keys()){let parent=parents.get(ref);const seen=new Set();while(parent&&!seen.has(parent)){seen.add(parent);if(byId.has(parent)){refresh.add(parent);parent=parents.get(parent);}else break;}}
   const refs=new Set([...perRef.keys(),...refresh]);
   const unavailable=[...refs].filter(ref=>!byId.has(ref)||(q.counts[ref]||0)>=max);
   if(unavailable.length){q.status='blocked';q.blockReason='以下复盘已到两轮自动修订上限：'+unavailable.map(ref=>byId.get(ref)?.title||ref).join('、');q.remaining.push(...unavailable.map(unit=>({unit,title:byId.get(unit)?.title,problem:'已到两轮自动修订上限，保留草稿等待人工处理'})));await save(run);return run;}
   pass.actions=items.filter(c=>refs.has(c.id)).map(c=>({ref:c.id,issues:clone(perRef.get(c.id)||[]),refresh:refresh.has(c.id),status:'pending'}));
   pass.actionsHash=qualityHash(pass.actions.map(({ref,issues,refresh})=>({ref,issues,refresh})));
   pass.status='revising';q.status='revising';await save(run);
  }
  for(const action of pass.actions){
   abort(signal);if(action.status==='done')continue;
   if(!action.reserved){q.counts[action.ref]=(q.counts[action.ref]||0)+1;action.reserved=true;action.revision=q.counts[action.ref];await save(run);}
   await onProgress({stage:`自动修订第 ${action.revision} 轮`,qualityPass:pass.index});
   // Freeze the exact request before its first call. On resume, completed child
   // revisions cannot accidentally change the input of an unfinished request.
   if(!action.before){action.before=clone(run.reviews);action.beforeHash=qualityHash(action.before);await save(run);}
   verifyPass(pass);
   const review=await revise(byId.get(action.ref),action,pass.index,q);abort(signal);
   run.reviews[action.ref]=review;action.status='done';action.afterHash=qualityHash(review);q.candidateHash=qualityHash(run.reviews);await save(run);
  }
  normalize();q.candidateHash=qualityHash(run.reviews);pass.status='done';q.status='checking';await save(run);
 }}catch(error){q.status='waiting';q.error=String(error.message);await save(run);throw error;}
}
