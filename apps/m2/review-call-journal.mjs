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
export async function initialReviewCall({gateway,system,user,key,skill,run,save=async()=>{},recordAttempt=async()=>{},signal,validate=x=>x}){
 const options={thinking:true,reasoningEffort:'high',maxTokens:32000,timeoutMs:900000};
 const inputHash=hash({system,user,skillHash:skill.hash,model:gateway.status?.model||null,options});
 const parse=answer=>{let value;try{value=JSON.parse(bareJson(answer));}catch{throw outputContractError();}if(!value||typeof value!=='object'||Array.isArray(value))throw outputContractError();return validate(value);};
 if(run.raw[key]){
  const cached=run.initialCache?.[key];
  if(cached&&(cached.inputHash!==inputHash||cached.outputHash!==hash(run.raw[key])))throw Object.assign(Error('初稿缓存与当前输入或原答不一致，未复用'),{code:'REVIEW_CACHE_MISMATCH'});
  return parse(run.raw[key]);
 }
 run.initialAttempts??=[];run.initialCache??={};
 const persist=async record=>{try{await recordAttempt(structuredClone(record));await save(run);}catch{throw Object.assign(Error('初稿调用记录无法保存，已停止处理，未采用回答'),{code:'REVIEW_JOURNAL_UNAVAILABLE',status:503});}};
 for(let attempt=1;attempt<=3;attempt++){
  signal?.throwIfAborted();
  const record={id:randomUUID(),key,attempt,inputHash,inputFingerprint:run.inputFingerprint||null,skill:{version:skill.version,hash:skill.hash},request:{system,user:structuredClone(user),model:gateway.status?.model||null,options},startedAt:new Date().toISOString(),status:'started',raw:null,rawAvailable:false,providerRequestId:null,finishReason:null};
  run.initialAttempts.push(record);await persist(record);
  let result,error;
  try{result=await gateway.complete([{role:'system',content:system},{role:'user',content:JSON.stringify(user)}],{...options,signal});}
  catch(e){error=e;}
  if(!result&&!error)error=outputContractError();
  record.finishedAt=new Date().toISOString();
  if(result){
   record.raw=typeof result.rawAnswer==='string'?result.rawAnswer:result.answer;record.rawAvailable=typeof record.raw==='string';record.rawCompleteness=record.rawAvailable?'returned':'unavailable';
   record.answerForParse=result.answer;record.model=result.model||gateway.status?.model||null;record.usage=result.usage||null;record.providerRequestId=result.providerRequestId||null;record.finishReason=result.finishReason||null;record.finishReasonSource=result.finishReasonSource||null;record.durationMs=result.durationMs??null;
   record.status='received';await persist(record); // Full returned text exists independently before JSON.parse.
   let value;
   try{value=parse(result.answer);}catch(e){error=e;}
   if(!error&&signal?.aborted)error=signal.reason||Object.assign(Error('用户已停止生成'),{name:'AbortError'});
   if(!error){
    record.status='accepted';await persist(record);
    run.raw[key]=result.answer;run.initialCache[key]={inputHash,outputHash:hash(result.answer),attemptId:record.id};try{await persist(record);}catch(e){delete run.raw[key];delete run.initialCache[key];throw e;}return value;
   }
   error.diagnostics={...error.diagnostics,model:record.model,usage:record.usage,finishReason:record.finishReason,finishReasonSource:record.finishReasonSource};
  }else{
   const raw=typeof error.rawAnswer==='string'?error.rawAnswer:error.partialAnswer;
   record.raw=typeof raw==='string'?raw:null;record.rawAvailable=typeof raw==='string';record.rawCompleteness=error.rawAnswer!==undefined?'provider-final':record.rawAvailable?'partial':'unavailable';
   record.model=error.diagnostics?.model||gateway.status?.model||null;record.usage=error.diagnostics?.usage||null;record.providerRequestId=error.providerRequestId||null;record.finishReason=error.diagnostics?.finishReason||null;record.finishReasonSource=error.diagnostics?.finishReasonSource||null;
  }
  record.status=error.code==='MODEL_OUTPUT_CONTRACT'?'output-contract-failed':refusal(error)?'provider-refusal':signal?.aborted?'cancelled':'call-failed';
  record.error={code:error.code||null,message:String(error.message),providerStatus:error.providerStatus??null};await persist(record);
  if(refusal(error))error.refusal=true;
  if(signal?.aborted||refusal(error)||attempt===3)throw error;
 }
}
