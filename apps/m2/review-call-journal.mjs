import {fallbackEligible,reviewModelApi} from './review-model-fallback.mjs';
import {reviewModelRequestBody} from './review-source-plan.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {bareJson} from './model.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refusal=e=>e?.code==='MODEL_REFUSAL'||e?.diagnostics?.finishReason==='refusal';
export const outputContractError=()=>Object.assign(Error('模型输出不符合 JSON 对象合同，未采用该回答'),{code:'MODEL_OUTPUT_CONTRACT',status:502});
export function createReviewCallJournal(dir){
 return async record=>{
  if(!/^[a-f0-9-]{36}$/.test(record.id))throw Error('调用记录ID无效');
  await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,record.id+'.json'),temp=path+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify({schemaVersion:1,...record}),{mode:0o600});await rename(temp,path);
 };
}
// A diagnostic record is persisted before parsing. It is not a successful raw
// cache entry; only a parsed, validated answer can enter run.raw.
export async function initialReviewCall({gateway,system,user,key,skill,run,save=async()=>{},recordAttempt=async()=>{},signal,evidenceFlow,validate=x=>x}){
 const options={thinking:true,reasoningEffort:'high',maxTokens:32000,timeoutMs:900000};
 const backups=gateway.reviewFallbacks||[],models=[gateway.status?.model||null,...backups.map(g=>g.status.model)];
 const inputHash=hash({system,user,skillHash:skill.hash,model:models[0],options,...(backups.length?{fallbackModels:models.slice(1)}:{})});
 const previous=run.initialAttempts?.filter(a=>a.key===key&&a.inputHash===inputHash)||[];
 if(user.initialContext)for(const record of previous)if(record.requestHash!==hash(record.request))throw Error('父级初稿实际请求记录已变化');
 let currentUser=user,contextProvided=false;const recoveredContext=[];
 if(evidenceFlow)for(const record of previous){
  if(record.requestHash!==hash(record.request))throw Error('初稿取证实际请求记录已变化');
  // The raw source request may have reached the independent journal before
  // its local continuation checkpoint. Recover it without paying to ask again.
  if(record.status==='received'&&record.answerForParse&&record.attempt<3){
   let parsed;try{parsed=JSON.parse(bareJson(record.answerForParse));}catch{/* An invalid raw still consumes its original physical attempt. */}
   if(parsed?.requestEvidence&&!parsed.review){
    const resolved=evidenceFlow.resolve(parsed,{system,wireOptions:{model:models[0],fallbackModels:models.slice(1),...options,json:false}});
    record.status='context-provided';record.evidenceRequest=structuredClone(parsed.requestEvidence);record.evidenceResponse=resolved.response;record.evidenceResponseHash=hash(resolved.response);record.contextNextUserHash=hash(resolved.user);recoveredContext.push(record);
   }
  }
  if(record.status==='context-provided'){
   if(contextProvided)throw Error('初稿取证次数超过冻结合同');
   if(hash(JSON.parse(bareJson(record.answerForParse)).requestEvidence)!==hash(record.evidenceRequest))throw Error('初稿原答与取证请求不一致');
   const resolved=evidenceFlow.resolve({requestEvidence:record.evidenceRequest},{system,wireOptions:{model:models[0],fallbackModels:models.slice(1),...options,json:false}});
   if(hash(resolved.response)!==record.evidenceResponseHash||hash(resolved.user)!==record.contextNextUserHash||hash(record.evidenceResponse)!==record.evidenceResponseHash)throw Error('初稿取证响应与冻结来源不一致');
   currentUser=resolved.user;contextProvided=true;
  }
 }
 const parse=answer=>{let value;try{value=JSON.parse(bareJson(answer));}catch{throw outputContractError();}if(!value||typeof value!=='object'||Array.isArray(value))throw outputContractError();return validate(value);};
 if(run.raw[key]){
  const cached=run.initialCache?.[key];
  if(cached&&(cached.inputHash!==inputHash||cached.outputHash!==hash(run.raw[key])))throw Object.assign(Error('初稿缓存与当前输入或原答不一致，未复用'),{code:'REVIEW_CACHE_MISMATCH'});
  if(backups.length&&cached){const attempt=run.initialAttempts?.find(a=>a.id===cached.attemptId);if(!models.includes(cached.selectedAlias)||attempt?.request.model!==cached.selectedAlias||attempt.returnedModel!==cached.returnedModel)throw Object.assign(Error('初稿备用模型缓存来源不一致'),{code:'REVIEW_CACHE_MISMATCH'});}
  const parsed=parse(run.raw[key]);if(evidenceFlow)evidenceFlow.validateReview(parsed.review,previous.at(-1).request.user);return parsed;
 }
 run.initialAttempts??=[];run.initialCache??={};
 const persist=async record=>{try{await recordAttempt(structuredClone(record));await save(run);}catch{throw Object.assign(Error('初稿调用记录无法保存，已停止处理，未采用回答'),{code:'REVIEW_JOURNAL_UNAVAILABLE',status:503});}};
 for(const record of recoveredContext)await persist(record);
 const route=new Map([[models[0],gateway],...backups.map(g=>[g.status.model,g])]);
 let active=backups.length||evidenceFlow?route.get(previous.at(-1)?.nextModel||previous.at(-1)?.request.model||models[0]):gateway;
 if(!active)throw Error('初稿备用来源不属于已授权策略');
 let switchFrom=previous.at(-1)?.switchFrom||null,switchReason=previous.at(-1)?.switchReason||null;
 const used=backups.length||evidenceFlow?previous.length:0;
 if(used>=3)throw Object.assign(Error('初稿同一逻辑请求三个模型尝试已用完'),{code:'REVIEW_MODEL_ATTEMPT_LIMIT'});
 for(let attempt=used+1;attempt<=3;attempt++){
  signal?.throwIfAborted();
  const requestUser=evidenceFlow&&attempt===3?evidenceFlow.finalize(currentUser):currentUser;
  const record={id:randomUUID(),key,attempt,inputHash,inputFingerprint:run.inputFingerprint||null,skill:{version:skill.version,hash:skill.hash},request:{system,user:structuredClone(requestUser),model:active.status?.model||null,api:reviewModelApi(active.status?.model),options},switchFrom,switchReason,startedAt:new Date().toISOString(),status:'started',raw:null,rawAvailable:false,providerRequestId:null,finishReason:null};
  if(evidenceFlow||user.initialContext)record.requestHash=hash(record.request);
  run.initialAttempts.push(record);await persist(record);
  let result,error;
  try{if(backups.length||evidenceFlow||user.initialContext){record.bodyBytes=Buffer.byteLength(JSON.stringify(reviewModelRequestBody(system,requestUser,{model:active.status.model,...options,json:false})));const limit=evidenceFlow?evidenceFlow.contract.maxBodyBytes-(!contextProvided&&attempt<3?evidenceFlow.contract.responseReserveBytes:0):512*1024;if(evidenceFlow||user.initialContext)record.bodyBudgetBytes=limit;if(record.bodyBytes>limit)throw Object.assign(Error('初稿完整请求超过本次工程预算，未调用'),{code:'REVIEW_PACKET_OVERSIZE'});}result=await active.complete([{role:'system',content:system},{role:'user',content:JSON.stringify(requestUser)}],{...options,signal});}
  catch(e){error=e;}
  if(!result&&!error)error=outputContractError();
  record.finishedAt=new Date().toISOString();
  if(result){
   record.raw=typeof result.rawAnswer==='string'?result.rawAnswer:result.answer;record.rawAvailable=typeof record.raw==='string';record.rawCompleteness=record.rawAvailable?'returned':'unavailable';
   record.answerForParse=result.answer;record.model=result.model||null;record.requestedAlias=active.status?.model||null;record.returnedModel=result.returnedModel??null;record.usage=result.usage||null;record.providerRequestId=result.providerRequestId||null;record.finishReason=result.finishReason||null;record.finishReasonSource=result.finishReasonSource||null;record.durationMs=result.durationMs??null;
   record.status='received';await persist(record); // Full returned text exists independently before JSON.parse.
   let value;
   try{value=parse(result.answer);
    if(evidenceFlow&&value.requestEvidence&&!value.review){
     if(contextProvided||attempt===3)throw outputContractError();
     const resolved=evidenceFlow.resolve(value,{system,wireOptions:{model:models[0],fallbackModels:models.slice(1),...options,json:false}});
     record.status='context-provided';record.evidenceRequest=structuredClone(value.requestEvidence);record.evidenceResponse=resolved.response;record.evidenceResponseHash=hash(resolved.response);record.contextNextUserHash=hash(resolved.user);await persist(record);
     currentUser=resolved.user;contextProvided=true;continue;
    }
    if(evidenceFlow)evidenceFlow.validateReview(value.review,requestUser);
   }catch(e){if(e.code==='REVIEW_JOURNAL_UNAVAILABLE')throw e;error=e;}
   if(!error&&signal?.aborted)error=signal.reason||Object.assign(Error('用户已停止生成'),{name:'AbortError'});
   if(!error){
    record.status='accepted';await persist(record);
    run.raw[key]=result.answer;run.initialCache[key]={inputHash,outputHash:hash(result.answer),attemptId:record.id,selectedAlias:record.request.model,returnedModel:record.returnedModel};try{await persist(record);}catch(e){delete run.raw[key];delete run.initialCache[key];throw e;}return value;
   }
   error.diagnostics={...error.diagnostics,model:record.model,usage:record.usage,finishReason:record.finishReason,finishReasonSource:record.finishReasonSource};
  }else{
   const raw=typeof error.rawAnswer==='string'?error.rawAnswer:error.partialAnswer;
   record.raw=typeof raw==='string'?raw:null;record.rawAvailable=typeof raw==='string';record.rawCompleteness=error.rawAnswer!==undefined?'provider-final':record.rawAvailable?'partial':'unavailable';
   record.model=error.diagnostics?.model||null;record.requestedAlias=active.status?.model||null;record.returnedModel=error.diagnostics?.returnedModel??null;record.usage=error.diagnostics?.usage||null;record.providerRequestId=error.providerRequestId||null;record.finishReasonSource=error.diagnostics?.finishReasonSource||null;record.finishReason=error.diagnostics?.providerFinishReason||(record.finishReasonSource?.startsWith('provider.')?error.diagnostics?.finishReason:null)||null;
  }
  record.status=error.code==='MODEL_OUTPUT_CONTRACT'?'output-contract-failed':refusal(error)?'provider-refusal':signal?.aborted?'cancelled':'call-failed';
  record.error={code:error.code||null,message:String(error.message),providerStatus:error.providerStatus??null};
  let switched=false;if(!signal?.aborted&&attempt<3&&backups.length&&active===gateway&&fallbackEligible(error)){record.nextModel=backups[0].status.model;record.switchFrom=active.status.model;record.switchReason=record.error;switchFrom=record.switchFrom;switchReason=record.switchReason;active=backups[0];switched=true;}
  await persist(record);
  if(refusal(error))error.refusal=true;
  if(signal?.aborted||error.code==='REVIEW_PACKET_OVERSIZE'||refusal(error)&&!switched||attempt===3)throw error;
 }
}
