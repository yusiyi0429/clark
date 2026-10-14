export function transientRoundFailure(error){
 if(error.code==='ONTOLOGY_RETRIES_EXHAUSTED')return false;
 return [408,429,500,502,503,504].includes(error.providerStatus)||['TimeoutError','AbortError'].includes(error.name)||['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(error.cause?.code)||error instanceof TypeError&&/fetch failed|network/i.test(error.message)||/模型响应提前结束|模型流式响应失败/.test(error.message);
}
export async function retryRoundCall(call,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),onRetry=async()=>{},attempts=3}={}){
 for(let attempt=1;;attempt++){
  try{return await call(attempt);}catch(error){
   if(attempt>=attempts||!transientRoundFailure(error))throw error;
   const delayMs=1000*2**(attempt-1);await onRetry({attempt:attempt+1,attempts,delayMs});await sleep(delayMs);
  }
 }
}
export function parseRoundJSON(answer,{audit=false}={}){
 let value;try{value=JSON.parse(answer);}catch{throw Object.assign(Error('模型返回格式不完整，未保存候选'),{code:'ROUND_JSON_INVALID'});}
 if(!value||typeof value!=='object'||Array.isArray(value)||audit&&(!Array.isArray(value.issues)||!Array.isArray(value.gaps)))throw Object.assign(Error('模型缺少审核结果字段，不能标为审核完成'),{code:'ROUND_JSON_INVALID'});
 if(audit&&value.issues.some(x=>!x||typeof x.problem!=='string'||!x.problem.trim()||typeof x.impact!=='string'||!x.impact.trim()))throw Object.assign(Error('审核问题缺少内容或影响，不能标为审核完成'),{code:'ROUND_JSON_INVALID'});
 return value;
}
