import {createModelGateway} from './model.mjs';
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

// This review-only factory is used by the real server; chat/decoding keep their own gateway.
export async function createReviewModelGateway({env=process.env,create=createModelGateway}={}){
 const [primary,backup]=await Promise.all(['wangsu/claude-sonnet-5-5','wangsu/gpt-6.1-sol'].map(model=>create({env:{...env,DECODING_MODEL:model}})));
 return withReviewFallbacks(primary,[backup]);
}

// A default-policy change applies to new work only. Resume uses the frozen
// aliases so paid requests, hashes and historical attribution stay unchanged.
export function reviewGatewayForRun(gateway,run){
 const frozen=run?.modelPolicy||run?.quality?.packetModel;
 if(!frozen){if(run?.initialAttempts?.length)throw Error('旧任务尚未保存完整模型策略，不能用新策略改写其缓存');return gateway;}
 const primary=frozen.primary||frozen.model,backups=frozen.fallbackModels||[];
 const available=[gateway,...(gateway.reviewFallbacks||[])],byModel=new Map(available.map(g=>[g.status?.model,g]));
 if(!byModel.has(primary)||backups.some(model=>!byModel.has(model)))throw Error('冻结任务的模型策略当前不可用，未改写历史策略');
 if(primary===gateway.status?.model&&JSON.stringify(backups)===JSON.stringify(gateway.reviewFallbacks?.map(g=>g.status.model)||[]))return gateway;
 if(!backups.length){const selected=byModel.get(primary);return {...selected,status:{...selected.status,reviewFallbackModels:[]},reviewFallbacks:[]};}
 return withReviewFallbacks(byModel.get(primary),backups.map(model=>byModel.get(model)));
}
