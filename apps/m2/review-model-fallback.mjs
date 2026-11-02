import {createModelGateway} from './model.mjs';
// Explicit opt-in for review-quality calls. Never changes production defaults.
const formalModels=new Set(['wangsu/gpt-6.1-sol','wangsu/claude-sonnet-5-5']);
export function withReviewFallbacks(primary,backups){
 const all=[primary,...backups],models=all.map(g=>g?.status?.model);
 if(!backups.length||all.length>2||new Set(models).size!==models.length||models.some(model=>!formalModels.has(model))||all.some(g=>typeof g?.complete!=='function'))throw Error('正式备用仅允许明确配置的GPT6.1与Sonnet各一个，不能用测试模型替代');
 return {...primary,status:{...primary.status,reviewFallbackModels:models.slice(1)},reviewFallbacks:[...backups]};
}
export function fallbackEligible(error){
 if(error?.name==='AbortError'||error?.code==='REVIEW_PACKET_OVERSIZE'||error?.code==='REVIEW_SOURCE_CONTEXT_PENDING')return false;
 return error?.code==='MODEL_REFUSAL'||error?.diagnostics?.finishReason==='refusal'||error?.code==='MODEL_OUTPUT_INCOMPLETE'||error?.code==='MODEL_OUTPUT_CONTRACT'||error?.reviewOutputContract===true||error instanceof SyntaxError||[429,500,502,503,504].includes(error?.providerStatus)||['ECONNRESET','ETIMEDOUT','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','MODEL_STREAM_INCOMPLETE','MODEL_STREAM_FAILURE'].some(code=>code===error?.code||code===error?.cause?.code);
}
export const reviewModelApi=model=>model==='wangsu/claude-sonnet-5-5'?'anthropic-messages':'chat-completions';

// This review-only factory is used by the real server; chat/decoding keep their own gateway.
export async function createReviewModelGateway({env=process.env,create=createModelGateway}={}){
 const [primary,backup]=await Promise.all(['wangsu/gpt-6.1-sol','wangsu/claude-sonnet-5-5'].map(model=>create({env:{...env,DECODING_MODEL:model}})));
 return withReviewFallbacks(primary,[backup]);
}
