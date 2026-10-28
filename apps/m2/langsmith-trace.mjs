// LangSmith tracing of M2's model calls (评测会话 2026-10-27, 陈溪南 approved): one run per model call, arranged as a tree
// with AsyncLocalStorage, so a call site only wraps its top-level work (a review job, a plan round, a Nexus pass) and every
// gateway.complete inside becomes an `llm` child of whatever is running. People's reactions (revision card accepted or
// not, a verdict changed, which version got signed, why a review job failed) go to the run that produced the thing.
//
// What leaves the server is what the model saw, with the same sensitive-detail rules applied again (redact.mjs), long
// text clipped, and a member's own insights before the reveal replaced by a count. Never a credential.
// Uploads are REST batches (POST {endpoint}/runs/batch) in the background: short timeout, no retries, a small memory
// cap; after repeated failures it pauses and drops, and the pause is one line in model-runs (never content).
// No key (env or this Mac's keychain), or LANGSMITH_TRACING=false: a no-op tracer, M2 works exactly as before.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {redactText} from './redact.mjs';

export function uuid7(now=Date.now()){
 const b=randomBytes(16),ms=BigInt(Math.floor(now));
 for(let i=0;i<6;i++)b[i]=Number((ms>>BigInt(8*(5-i)))&0xffn);
 b[6]=(b[6]&0x0f)|0x70;b[8]=(b[8]&0x3f)|0x80;
 const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// LANGSMITH_ENDPOINT may only point at LangSmith itself over HTTPS, so a mistyped variable cannot send traces elsewhere.
export function tracingConfig(env={},localKey){
 if(env.LANGSMITH_TRACING==='false')return null;
 const apiKey=String(env.LANGSMITH_API_KEY||localKey||'').trim();if(!apiKey)return null;
 const endpoint=String(env.LANGSMITH_ENDPOINT||'https://api.smith.langchain.com').trim().replace(/\/+$/,'');
 let url;try{url=new URL(endpoint);}catch{throw Error('LangSmith endpoint is not a URL');}
 if(url.protocol!=='https:'||!/^([a-z0-9-]+\.)+smith\.langchain\.com$/.test(url.hostname)||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/')throw Error('LangSmith endpoint must be https://*.smith.langchain.com');
 return {apiKey,endpoint:url.origin,project:String(env.LANGSMITH_PROJECT||'m2-local').trim().slice(0,100)||'m2-local'};
}
const run=promisify(execFile);
// Same pattern as the TokenHub key in model.mjs: read at runtime, never printed or stored.
async function readLocalKey(){
 if(process.platform!=='darwin')return undefined;
 try{return (await run('/usr/bin/security',['find-generic-password','-a','decoding-mvp','-s','TKOS-LangSmith','-w'],{timeout:5000})).stdout.trim()||undefined;}
 catch{return undefined;}
}

// ---------- what a trace may carry ----------
export function clip(value,max=60000,depth=0){
 if(typeof value==='string')return value.length>max?value.slice(0,max)+`…[+${value.length-max}]`:value;
 if(value==null||typeof value!=='object')return value;
 if(depth>8)return '[depth]';
 if(Array.isArray(value))return value.slice(0,200).map(v=>clip(v,max,depth+1));
 return Object.fromEntries(Object.entries(value).slice(0,200).map(([k,v])=>[k,clip(v,max,depth+1)]));
}
// insightView before the reveal gives a member their own insights as `mine` (private-agent-context.mjs): only the count goes out.
export function hideUnrevealedInsights(value,hidden=[]){
 if(Array.isArray(value))return value.map(v=>hideUnrevealedInsights(v,hidden));
 if(!value||typeof value!=='object')return value;
 if(value.revealed===false&&Array.isArray(value.mine)){for(const x of value.mine){const t=typeof x==='string'?x:x?.text;if(typeof t==='string'&&t.trim().length>=4)hidden.push(t.trim());}const {mine,...rest}=value;return {...hideUnrevealedInsights(rest,hidden),mine:{count:mine.length}};}
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,hideUnrevealedInsights(v,hidden)]));
}
// Messages are mostly a system prompt plus one JSON payload; the payload is read so unrevealed insights become counts.
export function traceMessages(messages,hidden=[]){
 return (Array.isArray(messages)?messages:[]).map(m=>{
  if(typeof m?.content!=='string'||!/^\s*[[{]/.test(m.content))return m;
  let parsed;try{parsed=JSON.parse(m.content);}catch{return m;}
  const before=hidden.length,next=hideUnrevealedInsights(parsed,hidden);
  return hidden.length>before?{...m,content:JSON.stringify(next)}:m;
 });
}
const HIDDEN='[未公开洞察]';
// Every string: the sensitive-detail rules (as the model saw it), unrevealed insight text that still shows up quoted
// (plain or inside a JSON payload), then clipped.
export function scrub(value,hidden=[],depth=0){
 if(typeof value==='string'){let s=redactText(value).text;for(const h of hidden)for(const form of [h,JSON.stringify(h).slice(1,-1)])if(s.includes(form))s=s.split(form).join(HIDDEN);return s;}
 if(value==null||typeof value!=='object')return value;
 if(depth>8)return '[depth]';
 if(Array.isArray(value))return value.map(v=>scrub(v,hidden,depth+1));
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v,hidden,depth+1)]));
}
const safe=(value,hidden)=>clip(scrub(value,hidden));
// Chat-completions and Messages usage → LangSmith usage_metadata; null when the service sent none.
export function usageMetadata(u){
 if(!u||typeof u!=='object')return null;
 const input=u.input_tokens??u.prompt_tokens,output=u.output_tokens??u.completion_tokens;
 if(!Number.isFinite(input)&&!Number.isFinite(output))return null;
 const out={input_tokens:input??0,output_tokens:output??0,total_tokens:u.total_tokens??((input??0)+(output??0))};
 const cached=u.cache_read_input_tokens??u.input_tokens_details?.cached_tokens??u.prompt_tokens_details?.cached_tokens;
 const reasoning=u.output_tokens_details?.reasoning_tokens??u.completion_tokens_details?.reasoning_tokens;
 if(Number.isFinite(cached))out.input_token_details={cache_read:cached};
 if(Number.isFinite(reasoning))out.output_token_details={reasoning};
 return out;
}
export const fingerprint=text=>createHash('sha256').update(String(text??'')).digest('hex').slice(0,12);
const defined=o=>Object.fromEntries(Object.entries(o||{}).filter(([,v])=>v!==undefined));

// ---------- uploader ----------
// One batch at a time; a failed batch is dropped, not retried. pauseAfterFailures in a row pauses for pauseMs and
// empties the queue, so a LangSmith outage never piles up in memory or slows M2.
export class Uploader {
 constructor({config,fetch=globalThis.fetch,clock=Date.now,timeoutMs=5000,flushMs=1000,maxBatch=100,maxQueueBytes=8*1024*1024,pauseAfterFailures=3,pauseMs=5*60000,onPause=()=>{}}){
  Object.assign(this,{config,fetchImpl:fetch,clock,timeoutMs,flushMs,maxBatch,maxQueueBytes,pauseAfterFailures,pauseMs,onPause});
  this.posts=new Map();this.patches=new Map();this.bytes=0;this.timer=null;this.flushing=null;
  this.stats={runs:0,sent:0,dropped:0,failures:0,consecutiveFailures:0,pausedUntil:0,pauses:0,lastError:null,feedback:0};
 }
 paused(){return this.clock()<this.stats.pausedUntil;}
 size(x){try{return JSON.stringify(x).length;}catch{return Infinity;}}
 // false: not queued (paused or full); the run is then dropped, children and its end included.
 post(payload){
  if(this.paused()){this.stats.dropped++;return false;}
  const n=this.size(payload);if(this.bytes+n>this.maxQueueBytes){this.stats.dropped++;return false;}
  this.posts.set(payload.id,{payload,n});this.bytes+=n;this.stats.runs++;this.schedule();return true;
 }
 // Not sent yet: the end goes into the same post, so a short run is sent once, complete.
 patch(payload){
  const queued=this.posts.get(payload.id);
  const n=this.size(payload);
  if(queued){Object.assign(queued.payload,payload);queued.n+=n;this.bytes+=n;return true;}
  if(this.paused()||this.bytes+n>this.maxQueueBytes){this.stats.dropped++;return false;}
  this.patches.set(payload.id,{payload,n});this.bytes+=n;this.schedule();return true;
 }
 schedule(){if(this.timer||this.flushing)return;this.timer=setTimeout(()=>{this.timer=null;this.flush().catch(()=>{});},this.flushMs);this.timer.unref?.();}
 take(map){const out=[];for(const [id,e] of map){if(out.length>=this.maxBatch)break;out.push(e.payload);this.bytes-=e.n;map.delete(id);}return out;}
 headers(){return {'x-api-key':this.config.apiKey,'Content-Type':'application/json'};}
 async send(path,body){
  if(this.paused())return false;
  let ok=false,reason=null;
  try{const r=await this.fetchImpl(this.config.endpoint+path,{method:'POST',headers:this.headers(),body:JSON.stringify(body),signal:AbortSignal.timeout(this.timeoutMs)});ok=r.ok||r.status===409;if(!ok)reason='HTTP '+r.status;}
  catch(error){reason=error?.cause?.code||error?.name||'network error';}
  this.health(ok,reason);return ok;
 }
 health(ok,reason){
  if(ok){this.stats.consecutiveFailures=0;return;}
  this.stats.failures++;this.stats.consecutiveFailures++;this.stats.lastError=String(reason||'').slice(0,80);
  if(this.stats.consecutiveFailures>=this.pauseAfterFailures){
   const dropped=this.posts.size+this.patches.size;
   this.stats.pausedUntil=this.clock()+this.pauseMs;this.stats.consecutiveFailures=0;this.stats.pauses++;this.stats.dropped+=dropped;
   this.posts.clear();this.patches.clear();this.bytes=0;
   try{Promise.resolve(this.onPause({reason:this.stats.lastError,failures:this.stats.failures,dropped:this.stats.dropped,pausedMs:this.pauseMs})).catch(()=>{});}catch{}
  }
 }
 async flush(){
  if(this.flushing)return this.flushing;
  clearTimeout(this.timer);this.timer=null;
  this.flushing=(async()=>{
   while(this.posts.size||this.patches.size){
    if(this.paused()){this.stats.dropped+=this.posts.size+this.patches.size;this.posts.clear();this.patches.clear();this.bytes=0;break;}
    const post=this.take(this.posts),patch=this.take(this.patches);
    if(await this.send('/runs/batch',{post,patch}))this.stats.sent+=post.length+patch.length;else this.stats.dropped+=post.length+patch.length;
   }
  })().finally(()=>{this.flushing=null;if(this.posts.size||this.patches.size)this.schedule();});
  return this.flushing;
 }
}

// ---------- tracer ----------
const als=new AsyncLocalStorage();
// YYYYMMDDTHHMMSSffffffZ from microseconds since the epoch.
const stamp=micro=>new Date(Math.floor(micro/1000)).toISOString().slice(0,19).replace(/[-:]/g,'')+String(micro%1000000).padStart(6,'0')+'Z';
const isoMicro=micro=>new Date(Math.floor(micro/1000)).toISOString().slice(0,19)+'.'+String(micro%1000000).padStart(6,'0')+'Z';
const errorText=e=>e==null?undefined:String(e?.message??e).slice(0,2000);

export class Tracer {
 constructor({project,uploader,clock=Date.now}){Object.assign(this,{project,uploader,clock});this.enabled=true;this.lastMicro=0;}
 current(){return als.getStore()||null;}
 // Start times strictly increase in this process, so a child always sorts after its parent in dotted_order.
 micro(ms){this.lastMicro=Math.max(Math.floor(ms*1000),this.lastMicro+1);return this.lastMicro;}
 startRun({name,type='chain',inputs={},metadata={},parent=this.current(),hide=[]}={}){
  try{
   if(parent?.dropped)return {...parent,dropped:true,ended:false,parent};
   const start=this.clock(),micro=this.micro(start),id=uuid7(start),traceId=parent?parent.trace_id:id;
   const inherit={...(parent?.inherit||{}),...defined(metadata)},hidden=parent?.hidden||[];hidden.push(...hide);
   const handle={id,trace_id:traceId,parent_run_id:parent?.id,dotted_order:(parent?parent.dotted_order+'.':'')+stamp(micro)+id,name:String(name||type).slice(0,200),run_type:type,start,inherit,meta:{...inherit},hidden,outputs:undefined,error:undefined,ended:false};
   handle.dropped=!this.uploader.post(defined({id,trace_id:traceId,parent_run_id:parent?.id,dotted_order:handle.dotted_order,name:handle.name,run_type:type,start_time:isoMicro(micro),inputs:safe(inputs,hidden),extra:{metadata:handle.meta},session_name:this.project}));
   return handle;
  }catch{return null;}
 }
 endRun(handle,{outputs,error,metadata}={}){
  try{
   if(!handle||handle.ended)return;handle.ended=true;if(handle.dropped)return;
   const end=this.clock(),err=errorText(error??handle.error);
   this.uploader.patch(defined({id:handle.id,trace_id:handle.trace_id,parent_run_id:handle.parent_run_id,dotted_order:handle.dotted_order,end_time:isoMicro(this.micro(end)),
    outputs:safe({...(handle.outputs||{}),...(outputs||{})},handle.hidden),error:err,extra:{metadata:{...handle.meta,...defined(metadata),duration_ms:end-handle.start}}}));
  }catch{}
 }
 // Runs fn with `handle` as the current run and ends it; fn's errors pass through unchanged.
 async within(handle,fn,{outputs}={}){
  if(!handle)return fn(null);
  return als.run(handle,async()=>{
   try{const value=await fn(handle);let out;try{out=outputs?outputs(value):undefined;}catch{}this.endRun(handle,{outputs:out});return value;}
   catch(error){this.endRun(handle,{error});throw error;}
  });
 }
 withRun(name,type,metadata,fn,{inputs,outputs}={}){return this.within(this.startRun({name,type,metadata,inputs}),fn,{outputs});}
 // Adds to the current run: outputs, metadata (also inherited by children started later), or an error without throwing.
 annotate({outputs,metadata,error}={},handle=this.current()){
  if(!handle||handle.ended)return;
  if(outputs)handle.outputs={...(handle.outputs||{}),...outputs};
  if(metadata){Object.assign(handle.meta,defined(metadata));Object.assign(handle.inherit,defined(metadata));}
  if(error!=null)handle.error=error;
 }
 // The small reference stored on what a run produced (a proposal, a job): optional, old state without it still works.
 ref(handle=this.current()){return handle&&!handle.dropped?{traceRunId:handle.id}:{};}
 // One model call. Inputs are the messages as the model received them; outputs the answer and the service's usage.
 async llm({messages,model,provider='tokenhub',settings={},trace={}},fn){
  const hidden=[],shown=traceMessages(trace.messages||messages,hidden),parent=this.current();
  const system=(Array.isArray(messages)?messages:[]).filter(m=>m?.role==='system').map(m=>m.content).join('\n');
  // Hidden texts join the whole trace's list, so this call's other fields and a parent's outputs quoting them are covered too.
  const handle=this.startRun({name:trace.name||model||'model',type:'llm',inputs:{messages:shown},parent,hide:hidden,
   metadata:{...trace.metadata,...(trace.stage?{stage:trace.stage}:{}),ls_provider:provider,ls_model_name:model,ls_model_type:'chat',model,reasoning_effort:settings.thinking===false?'disabled':settings.reasoningEffort,thinking:settings.thinking,json:settings.json||undefined,max_tokens:settings.maxTokens,prompt_fingerprint:system?fingerprint(system):undefined}});
  if(!handle)return fn();
  try{
   const r=await fn();
   this.endRun(handle,{outputs:{answer:r?.answer,...(usageMetadata(r?.usage)?{usage_metadata:usageMetadata(r.usage)}:{})},metadata:{provider_request_id:r?.providerRequestId,model_duration_ms:r?.durationMs,finish_reason:'stop'}});
   return r;
  }catch(error){
   const d=error?.diagnostics||{};
   this.endRun(handle,{error,outputs:{...(error?.partialAnswer?{partial_answer:error.partialAnswer}:{}),...(usageMetadata(d.usage)?{usage_metadata:usageMetadata(d.usage)}:{})},
    metadata:{error_code:error?.code,finish_reason:d.finishReason,refusal:error?.code==='MODEL_REFUSAL'||d.finishReason==='refusal'||undefined,http_status:error?.providerStatus}});
   throw error;
  }
 }
 // LangSmith feedback on a stored run id; a missing id (old state, tracing off then) sends nothing.
 feedback({runId,key,score,value,comment,actor}={}){
  try{
   if(!runId||!key)return false;
   this.uploader.stats.feedback++;
   this.uploader.send('/feedback',defined({id:uuid7(this.clock()),run_id:runId,key,score,value:value===undefined?undefined:safe(value),comment:comment==null?undefined:safe(String(comment).slice(0,1000)),feedback_source:{type:'app',metadata:defined({actor})}})).catch(()=>{});
   return true;
  }catch{return false;}
 }
 flush(){return this.uploader.flush().catch(()=>{});}
 state(){const s=this.uploader.stats;return {enabled:true,project:this.project,endpoint:new URL(this.uploader.config.endpoint).host,runs:s.runs,sent:s.sent,dropped:s.dropped,failures:s.failures,feedback:s.feedback,paused:this.uploader.paused(),lastError:s.lastError};}
}

// Off: the same calls, doing nothing, so call sites never branch.
export function disabledTracer(reason='no key'){
 return {enabled:false,current:()=>null,startRun:()=>null,endRun(){},within:(handle,fn)=>fn(null),withRun:(name,type,metadata,fn)=>fn(null),annotate(){},ref:()=>({}),llm:(spec,fn)=>fn(),feedback:()=>false,flush:async()=>{},state:()=>({enabled:false,reason})};
}
export function createTracer({config,fetch,clock=Date.now,...options}={}){
 if(!config)return disabledTracer();
 return new Tracer({project:config.project,clock,uploader:new Uploader({config,fetch,clock,...options})});
}

// The process-wide tracer the gateways and call sites use; configureTracing (server start) switches it on.
let active=disabledTracer();
export const tracer={
 get enabled(){return active.enabled;},
 current:()=>active.current(),startRun:spec=>active.startRun(spec),endRun:(h,x)=>active.endRun(h,x),within:(h,fn,o)=>active.within(h,fn,o),
 withRun:(name,type,metadata,fn,o)=>active.withRun(name,type,metadata,fn,o),annotate:(x,h)=>active.annotate(x,h),ref:h=>active.ref(h),
 llm:(spec,fn)=>active.llm(spec,fn),feedback:x=>active.feedback(x),flush:()=>active.flush(),state:()=>active.state(),
};
export function setTracer(next){const was=active;active=next||disabledTracer();return was;}
// Tests never trace (they inject their own tracer); a bad endpoint turns tracing off instead of stopping the server.
export async function configureTracing({env=process.env,readLocalSecret=readLocalKey,fetch=globalThis.fetch,onPause}={}){
 if(env.NODE_ENV==='test'||env.LANGSMITH_TRACING==='false'){setTracer(disabledTracer(env.NODE_ENV==='test'?'test':'off'));return tracer.state();}
 let config;
 try{config=tracingConfig(env,env.LANGSMITH_API_KEY?undefined:await readLocalSecret());}catch(e){setTracer(disabledTracer(e.message));return tracer.state();}
 setTracer(config?createTracer({config,fetch,onPause}):disabledTracer());
 return tracer.state();
}

// ---------- people's reactions as feedback ----------
const versionOf=card=>card?.versions?.at(-1);
// Called after an action is applied, with the state before and after; looks up the run ids stored when things were made.
export function actionFeedback(t,before,after,action,actor){
 try{
  if(!t?.enabled||!action||!after)return;
  const who=actor?.id;
  if(['acceptProposal','rejectProposal'].includes(action.type)){
   const p=(after.proposals||[]).find(x=>x.id===action.proposalId);if(!p||!['accepted','rejected'].includes(p.status))return;
   const accepted=p.status==='accepted',what=p.op||Object.keys(p.patch||{}).join(',');
   if(p.traceRunId)t.feedback({runId:p.traceRunId,key:'revision_card',score:accepted?1:0,value:p.status,actor:who,
    comment:[`card ${p.cardId}`,what&&`fields ${what}`,p.edited&&'accepted with edits',p.auto&&'auto',p.rejectReason&&`reason: ${p.rejectReason}`].filter(Boolean).join(' · ')});
   if(p.verdictChange){const rid=after.reviewRound?.traceRunId;if(rid)t.feedback({runId:rid,key:'verdict_change',score:accepted?0:1,value:`${p.status}: ${p.verdictChange.from}→${p.verdictChange.to}`,comment:`card ${p.cardId}`,actor:who});}
   return;
  }
  // A person changing a review's verdict files a verdictChange proposal (governance.mjs): the generated verdict was disputed.
  if(action.type==='revise'){
   const known=new Set((before?.proposals||[]).map(p=>p.id));
   for(const p of (after.proposals||[]).filter(p=>!known.has(p.id)&&p.verdictChange)){const rid=after.reviewRound?.traceRunId;if(rid)t.feedback({runId:rid,key:'verdict_change',value:`requested: ${p.verdictChange.from}→${p.verdictChange.to}`,comment:`card ${p.cardId}`,actor:who});}
   return;
  }
  if(action.type==='confirm'){
   const card=after.cards?.[action.cardId],v=versionOf(card),was=versionOf(before?.cards?.[action.cardId]);
   if(!v||(was&&was.signatures?.length===v.signatures?.length))return;
   const review=card.kind==='review',job=after.roundJob;
   const rid=review?after.reviewRound?.traceRunId:job?.id&&job.id===after.round?.id?job.traceRunId:undefined;
   const fb={key:'signed_version',score:v.number===1?1:0,value:v.number,actor:who,comment:`card ${card.id} · slot ${action.slot}${card.confirmedVersion===v.number?' · confirmed':''}`};
   if(rid)t.feedback({...fb,runId:rid});
   // A version Nexus wrote through an accepted card: the signature also counts for that Nexus run.
   const via=(after.proposals||[]).find(p=>p.cardId===card.id&&p.status==='accepted'&&p.resultVersion===v.number&&p.traceRunId);
   if(via)t.feedback({...fb,runId:via.traceRunId});
  }
 }catch{}
}
