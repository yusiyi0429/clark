import {createModelGateway} from './model.mjs';
import {setTimeout as pause} from 'node:timers/promises';
// Review-only production policy. Chat/decoding keep their own model settings.
export const REVIEW_BODY_LIMIT_BYTES=2*1024*1024;
const formalModels=new Set(['wangsu/gpt-6.1-sol','wangsu/claude-sonnet-5-5']);
export function withReviewFallbacks(primary,backups){
 const all=[primary,...backups],models=all.map(g=>g?.status?.model);
 if(!backups.length||all.length>2||new Set(models).size!==models.length||models.some(model=>!formalModels.has(model))||all.some(g=>typeof g?.complete!=='function'))throw Error('正式备用仅允许明确配置的GPT6.1与Sonnet各一个，不能用测试模型替代');
 return {...primary,status:{...primary.status,reviewFallbackModels:models.slice(1)},reviewFallbacks:[...backups]};
}
export function fallbackEligible(error){
 if(error?.name==='AbortError'||error?.code==='REVIEW_PACKET_OVERSIZE'||error?.code==='REVIEW_SOURCE_CONTEXT_PENDING')return false;
 return error?.name==='TimeoutError'||error?.code==='MODEL_REFUSAL'||error?.diagnostics?.finishReason==='refusal'||error?.code==='MODEL_OUTPUT_INCOMPLETE'||error?.code==='MODEL_OUTPUT_CONTRACT'||error?.reviewOutputContract===true||error instanceof SyntaxError||[429,500,502,503,504].includes(error?.providerStatus)||['ECONNRESET','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','MODEL_STREAM_INCOMPLETE','MODEL_STREAM_FAILURE'].some(code=>code===error?.code||code===error?.cause?.code);
}
export const reviewModelApi=model=>model==='wangsu/claude-sonnet-5-5'?'anthropic-messages':'chat-completions';
export const reviewInitialConcurrency=gateway=>Math.min(20,Number.isInteger(gateway?.roundConcurrency)&&gateway.roundConcurrency>0?gateway.roundConcurrency:8);

export const reviewQualityFallbackContract=()=>({version:1,fromQualityPass:1,repairModel:'wangsu/gpt-6.1-sol',repairFallbackModels:[],scope:'all-actions-including-new-and-refresh',checks:'frozen-round-policy'});
export function validateReviewQualityFallback(input){const policy=input.engineeringContracts?.qualityFallback;if(policy!==undefined&&JSON.stringify(policy)!==JSON.stringify(reviewQualityFallbackContract()))throw Error('质量修订备用合同不受支持');return policy;}
export function reviewGatewayForQualityAction(gateway,input,pass,stage){
 const policy=validateReviewQualityFallback(input);
 if(!policy||pass<policy.fromQualityPass||!/^(?:revise|refresh)(?:-source)?$/.test(stage))return gateway;
 return reviewGatewayForRun(gateway,{modelPolicy:{primary:policy.repairModel,fallbackModels:policy.repairFallbackModels}});
}

// Share provider cooldown across the review calls already bounded by the pool.
// Waiting never adds a transport attempt or changes the frozen request body.
export function withReviewRateLimit(gateway,{now=Date.now,wait=(ms,signal)=>pause(ms,undefined,{signal})}={}){
 let blockedUntil=0;
 return {...gateway,async complete(messages,options={}){
  while(blockedUntil>now()){options.signal?.throwIfAborted();await wait(Math.min(60000,blockedUntil-now()),options.signal);}
  try{return await gateway.complete(messages,options);}catch(error){
   if(error.providerStatus===429){const delay=Number.isFinite(error.retryAfterMs)&&error.retryAfterMs>0?error.retryAfterMs:1000;blockedUntil=Math.max(blockedUntil,now()+delay);}
   throw error;
  }
 }};
}

// This review-only factory is used by the real server; chat/decoding keep their own gateway.
export async function createReviewModelGateway({env=process.env,create=createModelGateway}={}){
 const requested=env.M2_REVIEW_PRIMARY_MODEL||'wangsu/claude-sonnet-5-5';
 if(!formalModels.has(requested))throw Error('M2_REVIEW_PRIMARY_MODEL仅支持正式Sonnet5.5或GPT6.1-sol');
 const available=await Promise.all(['wangsu/claude-sonnet-5-5','wangsu/gpt-6.1-sol'].map(async model=>{const gateway=withReviewRateLimit(await create({env:{...env,DECODING_MODEL:model}}));if(gateway.status?.model!==model)throw Error('正式复盘模型配置与实际网关不一致');return gateway;}));
 const [claude,gpt]=available;
 const selected=requested===claude.status.model?withReviewFallbacks(claude,[gpt]):{...gpt,status:{...gpt.status,reviewFallbackModels:[]},reviewFallbacks:[]};
 // Availability is not a fallback policy. Keep old frozen jobs resumable even
 // after changing the default, without routing any new GPT-only call to Claude.
 return {...selected,reviewResumeGateways:available};
}

// A default-policy change applies to new work only. Resume uses the frozen
// aliases so paid requests, hashes and historical attribution stay unchanged.
export function reviewGatewayForRun(gateway,run){
 const frozen=run?.modelPolicy||run?.quality?.packetModel;
 if(!frozen){if(run?.initialAttempts?.length)throw Error('旧任务尚未保存完整模型策略，不能用新策略改写其缓存');return gateway;}
 const primary=frozen.primary||frozen.model,backups=frozen.fallbackModels||[];
 const available=[gateway,...(gateway.reviewFallbacks||[]),...(gateway.reviewResumeGateways||[])],byModel=new Map(available.map(g=>[g.status?.model,g]));
 if(!byModel.has(primary)||backups.some(model=>!byModel.has(model)))throw Error('冻结任务的模型策略当前不可用，未改写历史策略');
 if(primary===gateway.status?.model&&JSON.stringify(backups)===JSON.stringify(gateway.reviewFallbacks?.map(g=>g.status.model)||[]))return gateway;
 if(!backups.length){const selected=byModel.get(primary);return {...selected,status:{...selected.status,reviewFallbackModels:[]},reviewFallbacks:[],...(gateway.reviewResumeGateways?{reviewResumeGateways:gateway.reviewResumeGateways}:{})};}
 return {...withReviewFallbacks(byModel.get(primary),backups.map(model=>byModel.get(model))),...(gateway.reviewResumeGateways?{reviewResumeGateways:gateway.reviewResumeGateways}:{})};
}
