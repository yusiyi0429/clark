import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export const TOKENHUB_BASE='http://115.191.26.230:8000/api/openai/v1';
export const TOKENHUB_MODEL='aliyun/deepseek-v4.1-flash';
const run=promisify(execFile);
async function completionResponse(response,onDelta){
 if(!response.headers?.get?.('content-type')?.includes('text/event-stream')){const result=await response.json();const content=result.choices?.[0]?.message?.content;if(content&&onDelta)await onDelta(content);return result;}
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',answer='',usage,id,finish;
 const consume=async line=>{
  if(!line.startsWith('data:'))return;
  const text=line.slice(5).trim();if(!text||text==='[DONE]')return;
  const chunk=JSON.parse(text);if(chunk.error)throw Error('模型流式响应失败，未应用内容');
  id=chunk.id||id;usage=chunk.usage||usage;
  for(const choice of chunk.choices||[]){const delta=choice.delta?.content||'';answer+=delta;if(delta&&onDelta)await onDelta(delta);finish=choice.finish_reason||finish;}
 };
 try{while(true){const {done,value}=await reader.read();pending+=decoder.decode(value,{stream:!done});let index;while((index=pending.indexOf('\n'))>=0){await consume(pending.slice(0,index).trim());pending=pending.slice(index+1);}if(done)break;}
 if(pending)await consume(pending.trim());}finally{await reader.cancel().catch(()=>{});}
 if(!finish)throw Error('模型响应提前结束，未应用内容');
 return {id,usage,choices:[{message:{content:answer},finish_reason:finish}]};
}
async function readLocalKey(){
 if(process.platform!=='darwin')return undefined;
 try{return (await run('/usr/bin/security',['find-generic-password','-a','decoding-mvp','-s','TKOS-TokenHub','-w'],{timeout:5000})).stdout.trim();}
 catch{return undefined;}
}

// One shared server-only gateway for personal Agent, Nexus and decoding.
// The documented HTTP exception is restricted to the team's exact TokenHub endpoint.
export async function createModelGateway({env=process.env,readSecretFile=readFile,readLocalSecret=readLocalKey,transport=fetch}={}){
 const base=env.DECODING_API_BASE||TOKENHUB_BASE;
 const model=env.DECODING_MODEL||TOKENHUB_MODEL;
 const endpoint=new URL(base.replace(/\/?$/,'/')+'chat/completions');
 const tokenhub=endpoint.origin===new URL(TOKENHUB_BASE).origin&&endpoint.pathname==='/api/openai/v1/chat/completions';
 if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||(!tokenhub&&endpoint.protocol!=='https:'))throw Error('模型接口必须使用 HTTPS，仅允许文档指定的 TokenHub HTTP 地址');
 const ark=endpoint.hostname==='ark.cn-beijing.volces.com';
 let key=env.DECODING_API_KEY||(tokenhub?env.TOKENHUB_API_KEY:ark?env.ARK_API_KEY:undefined);
 if(!key&&env.DECODING_API_KEY_FILE)key=(await readSecretFile(env.DECODING_API_KEY_FILE,'utf8')).trim();
 if(!key&&tokenhub&&env.NODE_ENV!=='test'&&env.DECODING_DISABLE_LOCAL_KEY!=='1'&&env.DECODING_DISABLE_LEGACY_KEY!=='1')key=await readLocalSecret();
 return {
  status:{ready:Boolean(key),provider:tokenhub?'TokenHub':ark?'Ark':'OpenAI-compatible',model},
  async complete(messages,{json=false,maxTokens,timeoutMs=900000,thinking=model===TOKENHUB_MODEL,reasoningEffort='high',onDelta,signal}={}){
   if(!key){const e=Error('服务端未配置模型密钥');e.status=503;throw e;}
   // JSON mode requires an explicit JSON instruction on compatible providers.
   // Keep caller-owned messages untouched and leave ordinary chat unchanged.
   const requestMessages=json&&!messages.some(m=>typeof m.content==='string'&&/json/i.test(m.content))
    ?[{role:'system',content:'仅返回有效 JSON 对象，不加代码围栏。'},...messages]:messages;
   if(reasoningEffort&&!['low','high','max'].includes(reasoningEffort))throw Error('思考强度必须为 low、high 或 max');
   if(thinking&&model!==TOKENHUB_MODEL)throw Error('当前模型未核实拆解思考参数，停止生成');
   // Personal Agent, Nexus and decoding default to the highest verified DeepSeek effort.
   const response=await transport(endpoint,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,...(tokenhub?{stream:true,stream_options:{include_usage:true}}:{}),...(ark?{thinking:{type:'disabled'}}:{}),...(model===TOKENHUB_MODEL?{enable_thinking:thinking,...(thinking?{reasoning_effort:reasoningEffort||'max'}:{})}:{}),max_tokens:maxTokens||(thinking?65536:json?4000:2400),...(json?{response_format:{type:'json_object'}}:{}),messages:requestMessages})});
   if(!response.ok){const e=Error(`模型接口返回 ${response.status}，未修改任何卡片。`);e.status=502;e.providerStatus=response.status;throw e;}
   const result=await completionResponse(response,onDelta),answer=result.choices?.[0]?.message?.content;
   if(!answer||result.choices?.[0]?.finish_reason==='length'){
    const e=Error('模型输出不完整，未应用修改。');e.status=502;e.code='MODEL_OUTPUT_INCOMPLETE';
    e.diagnostics={model,finishReason:result.choices?.[0]?.finish_reason||'empty',usage:result.usage,reasoningEffort:thinking?reasoningEffort:'disabled',maxTokens:maxTokens||(thinking?65536:json?4000:2400)};
    await recordModelRun({channel:'model-failure',model,usage:result.usage,providerRequestId:result.id,failure:e.diagnostics});throw e;
   }
   return {answer,usage:result.usage,providerRequestId:result.id,model};
  },
 };
}
export async function recordModelRun({channel,scope,selection,model,usage,providerRequestId,failure}){
 const id=randomUUID(),dir=process.env.NODE_ENV==='test'&&process.env.DECODING_STATE_PATH?new URL('./model-runs/',pathToFileURL(process.env.DECODING_STATE_PATH)):new URL('./.runtime/model-runs/',import.meta.url);
 await mkdir(dir,{recursive:true,mode:0o700});
 await writeFile(new URL(id+'.json',dir),JSON.stringify({id,channel,scope,selection,model,usage,providerRequestId,failure,createdAt:new Date().toISOString()}),{mode:0o600});
 return id;
}
