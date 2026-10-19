import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// TokenHub moved to an HTTPS domain on 2026-10-16 (王创峰, TKOS 全员); the old IP:port address is no longer used.
export const TOKENHUB_BASE='https://tokenhub.corp.tokenkingos.com/api/openai/v1';
export const TOKENHUB_MODEL='aliyun/deepseek-v4.1-flash';
// Request shape per model whose thinking parameters were checked on TokenHub; other models stop rather than guess.
export const MODEL_PROFILES={
 'aliyun/deepseek-v4.1-flash':{thinking:(on,effort)=>({enable_thinking:on,...(on?{reasoning_effort:effort||'max'}:{})}),maxTokensField:'max_tokens'},
 // TokenHub drops streamed responses for this model (checked 2026-10-15), so it answers in one piece.
 // Each GPT stream keeps its own speed (about 40 tokens/s even at 20 concurrent calls, measured 2026-10-15), so a round can fan out wide.
 'wangsu/gpt-6.1-sol':{thinking:(on,effort)=>(on?{reasoning_effort:effort||'high'}:{}),maxTokensField:'max_completion_tokens',stream:false,roundConcurrency:40},
 // Claude on TokenHub speaks only the Messages API (/api/anthropic/v1/messages). Checked 2026-10-19: streaming works
 // (first text in ~2 s), thinking accepts only {type:'adaptive'} with output_config.effort; there is no JSON mode.
 'wangsu/claude-sonnet-5-5':{api:'anthropic',roundConcurrency:20},
 'wangsu/claude-opus-5-5':{api:'anthropic',roundConcurrency:10},
 'wangsu/claude-haiku-5-5':{api:'anthropic',roundConcurrency:20},
};
const run=promisify(execFile);
// Messages API stream: text deltas become the answer; stop_reason max_tokens counts as cut off.
async function messagesResponse(response,onDelta){
 if(!response.headers?.get?.('content-type')?.includes('text/event-stream')){const r=await response.json();const answer=(r.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');if(answer&&onDelta)await onDelta(answer);return {id:r.id,usage:r.usage,answer,stop:r.stop_reason};}
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',answer='',usage={},id,stop;
 const consume=async line=>{
  if(!line.startsWith('data:'))return;const text=line.slice(5).trim();if(!text)return;
  const e=JSON.parse(text);if(e.type==='error')throw Error('模型流式响应失败，未应用内容');
  if(e.type==='message_start'){id=e.message?.id;usage={...usage,...e.message?.usage};}
  if(e.type==='content_block_delta'&&e.delta?.type==='text_delta'){answer+=e.delta.text;if(onDelta)await onDelta(e.delta.text);}
  if(e.type==='message_delta'){stop=e.delta?.stop_reason||stop;usage={...usage,...e.usage};}
 };
 try{while(true){const {done,value}=await reader.read();pending+=decoder.decode(value,{stream:!done});let index;while((index=pending.indexOf('\n'))>=0){await consume(pending.slice(0,index).trim());pending=pending.slice(index+1);}if(done)break;}
 if(pending)await consume(pending.trim());}finally{await reader.cancel().catch(()=>{});}
 if(!stop)throw Error('模型响应提前结束，未应用内容');
 return {id,usage,answer,stop};
}
// Claude may wrap JSON in a code fence; callers parse the object itself.
export function bareJson(text){const s=String(text||'').trim(),a=s.indexOf('{'),b=s.lastIndexOf('}');return a>=0&&b>a?s.slice(a,b+1):s;}
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
// A non-streamed answer can take many minutes before its first byte; fetch gives up on headers after five,
// so these calls use node:http with keep-alive and rely on the caller's overall timeout instead.
export function patientTransport(url,{method,headers,body,signal}){
 return new Promise((resolve,reject)=>{
  const target=new URL(url);
  const req=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method,headers},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
   res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,headers:{get:name=>res.headers[name.toLowerCase()]??null},json:async()=>JSON.parse(text),text:async()=>text});});
  });
  req.on('socket',socket=>socket.setKeepAlive(true,30000));
  req.on('error',reject);
  if(signal){if(signal.aborted)req.destroy(signal.reason);else signal.addEventListener('abort',()=>req.destroy(signal.reason||Error('aborted')),{once:true});}
  req.end(body);
 });
}
export async function createModelGateway({env=process.env,readSecretFile=readFile,readLocalSecret=readLocalKey,transport=fetch}={}){
 const base=env.DECODING_API_BASE||TOKENHUB_BASE;
 const model=env.DECODING_MODEL||TOKENHUB_MODEL;
 const endpoint=new URL(base.replace(/\/?$/,'/')+'chat/completions');
 const tokenhub=endpoint.origin===new URL(TOKENHUB_BASE).origin&&endpoint.pathname==='/api/openai/v1/chat/completions';
 if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.protocol!=='https:')throw Error('模型接口必须使用 HTTPS');
 const ark=endpoint.hostname==='ark.cn-beijing.volces.com';
 let key=env.DECODING_API_KEY||(tokenhub?env.TOKENHUB_API_KEY:ark?env.ARK_API_KEY:undefined);
 if(!key&&env.DECODING_API_KEY_FILE)key=(await readSecretFile(env.DECODING_API_KEY_FILE,'utf8')).trim();
 if(!key&&tokenhub&&env.NODE_ENV!=='test'&&env.DECODING_DISABLE_LOCAL_KEY!=='1'&&env.DECODING_DISABLE_LEGACY_KEY!=='1')key=await readLocalSecret();
 const messagesEndpoint=tokenhub?new URL(endpoint.origin+'/api/anthropic/v1/messages'):new URL(base.replace(/\/?$/,'/')+'messages');
 async function messagesComplete(messages,{json,maxTokens,timeoutMs,thinking,reasoningEffort,onDelta,signal,startedAt}){
  const system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n');
  const turns=[];for(const m of messages.filter(m=>m.role!=='system')){const role=m.role==='assistant'?'assistant':'user';if(turns.at(-1)?.role===role)turns.at(-1).content+='\n\n'+m.content;else turns.push({role,content:String(m.content)});}
  const limit=maxTokens||(thinking?32000:json?4000:2400);
  const response=await transport(messagesEndpoint,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${key}`,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model,max_tokens:limit,stream:true,...(system?{system}:{}),messages:turns,...(thinking?{thinking:{type:'adaptive'},output_config:{effort:reasoningEffort||'high'}}:{})})});
  if(!response.ok){const e=Error(`模型接口返回 ${response.status}，未修改任何卡片。`);e.status=502;e.providerStatus=response.status;await recordModelRun({channel:'model-failure',model,failure:{httpStatus:response.status}}).catch(()=>{});throw e;}
  const r=await messagesResponse(response,onDelta),usage={prompt_tokens:r.usage?.input_tokens,completion_tokens:r.usage?.output_tokens,...r.usage};
  if(!r.answer||r.stop==='max_tokens'){const e=Error('模型输出不完整，未应用修改。');e.status=502;e.code='MODEL_OUTPUT_INCOMPLETE';e.partialAnswer=r.answer||'';e.diagnostics={model,finishReason:r.stop||'empty',usage,reasoningEffort:thinking?reasoningEffort:'disabled',maxTokens:limit};await recordModelRun({channel:'model-failure',model,usage,providerRequestId:r.id,failure:e.diagnostics});throw e;}
  return {answer:json?bareJson(r.answer):r.answer,usage,providerRequestId:r.id,model,durationMs:Date.now()-startedAt};
 }
 return {
  status:{ready:Boolean(key),provider:tokenhub?'TokenHub':ark?'Ark':'OpenAI-compatible',model},
  roundConcurrency:MODEL_PROFILES[model]?.roundConcurrency,
  async complete(messages,{json=false,maxTokens,timeoutMs=900000,thinking=Boolean(MODEL_PROFILES[model]),reasoningEffort='high',onDelta,signal}={}){
   if(!key){const e=Error('服务端未配置模型密钥');e.status=503;throw e;}
   const startedAt=Date.now();
   // JSON mode requires an explicit JSON instruction on compatible providers.
   // Keep caller-owned messages untouched and leave ordinary chat unchanged.
   const requestMessages=json&&!messages.some(m=>typeof m.content==='string'&&/json/i.test(m.content))
    ?[{role:'system',content:'仅返回有效 JSON 对象，不加代码围栏。'},...messages]:messages;
   if(reasoningEffort&&!['low','medium','high','max'].includes(reasoningEffort))throw Error('思考强度必须为 low、medium、high 或 max');
   const profile=MODEL_PROFILES[model];
   if(thinking&&!profile)throw Error('当前模型未核实拆解思考参数，停止生成');
   if(profile?.api==='anthropic')return messagesComplete(requestMessages,{json,maxTokens,timeoutMs,thinking,reasoningEffort,onDelta,signal,startedAt});
   // Personal Agent, Nexus and decoding default to the highest verified DeepSeek effort.
   const send=profile?.stream===false&&transport===fetch?patientTransport:transport;
   const response=await send(endpoint,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,...(tokenhub&&profile?.stream!==false?{stream:true,stream_options:{include_usage:true}}:{}),...(ark?{thinking:{type:'disabled'}}:{}),...(profile?profile.thinking(thinking,reasoningEffort):{}),[profile?.maxTokensField||'max_tokens']:maxTokens||(thinking?65536:json?4000:2400),...(json?{response_format:{type:'json_object'}}:{}),messages:requestMessages})});
   if(!response.ok){
    const e=Error(`模型接口返回 ${response.status}，未修改任何卡片。`);e.status=502;e.providerStatus=response.status;
    const retryAfter=Number(response.headers?.get?.('retry-after'));if(Number.isFinite(retryAfter)&&retryAfter>=0)e.retryAfterMs=retryAfter*1000;
    // HTTP failures were invisible in model-runs; keep status only, never request content.
    await recordModelRun({channel:'model-failure',model,failure:{httpStatus:response.status,retryAfterMs:e.retryAfterMs??null}}).catch(()=>{});throw e;
   }
   const result=await completionResponse(response,onDelta),answer=result.choices?.[0]?.message?.content;
   if(!answer||result.choices?.[0]?.finish_reason==='length'){
    const e=Error('模型输出不完整，未应用修改。');e.status=502;e.code='MODEL_OUTPUT_INCOMPLETE';e.partialAnswer=answer||'';
    e.diagnostics={model,finishReason:result.choices?.[0]?.finish_reason||'empty',usage:result.usage,reasoningEffort:thinking?reasoningEffort:'disabled',maxTokens:maxTokens||(thinking?65536:json?4000:2400)};
    await recordModelRun({channel:'model-failure',model,usage:result.usage,providerRequestId:result.id,failure:e.diagnostics});throw e;
   }
   return {answer,usage:result.usage,providerRequestId:result.id,model,durationMs:Date.now()-startedAt};
  },
 };
}
export async function recordModelRun({channel,scope,selection,model,usage,providerRequestId,failure,durationMs}){
 const id=randomUUID(),dir=process.env.DECODING_RUNS_DIR?new URL('./model-runs/',pathToFileURL(process.env.DECODING_RUNS_DIR+'/')):process.env.NODE_ENV==='test'&&process.env.DECODING_STATE_PATH?new URL('./model-runs/',pathToFileURL(process.env.DECODING_STATE_PATH)):new URL('./.runtime/model-runs/',import.meta.url);
 await mkdir(dir,{recursive:true,mode:0o700});
 await writeFile(new URL(id+'.json',dir),JSON.stringify({id,channel,scope,selection,model,usage,providerRequestId,failure,durationMs,createdAt:new Date().toISOString()}),{mode:0o600});
 return id;
}
// Rejected round output is kept for diagnosis only, apart from model-runs (which never hold content).
export async function recordRoundFailure({scope,reason,answer}){
 const id=randomUUID(),dir=process.env.DECODING_RUNS_DIR?new URL('./round-failures/',pathToFileURL(process.env.DECODING_RUNS_DIR+'/')):process.env.NODE_ENV==='test'&&process.env.DECODING_STATE_PATH?new URL('./round-failures/',pathToFileURL(process.env.DECODING_STATE_PATH)):new URL('./.runtime/round-failures/',import.meta.url);
 await mkdir(dir,{recursive:true,mode:0o700});
 await writeFile(new URL(id+'.json',dir),JSON.stringify({id,scope,reason,answer:String(answer??'').slice(0,400000),createdAt:new Date().toISOString()}),{mode:0o600});
 return id;
}
