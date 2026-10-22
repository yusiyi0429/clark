import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildGeneratorInput} from './ontology-input.mjs';
import {codexBridgeStatus,readThroughCodex} from './codex-ontology-bridge.mjs';
import {retryRoundCall,transientRoundFailure} from './round-retry.mjs';
import {seedRoot} from './deployment-data.mjs';
import {join} from 'node:path';
const manifestURL=process.env.M2_ONTOLOGY_MANIFEST_FILE||join(seedRoot(),'source-manifest.json');
export async function loadOntologyManifest(url=manifestURL){
 const manifest=JSON.parse(await readFile(url,'utf8'));
 // Reference answers listed in the manifest are counted (for the coverage view) and never selected.
 const answers=manifest.selections.filter(s=>s.isAnswer);
 manifest.answerExclusions={objects:answers.length,byType:answers.reduce((g,s)=>(g[s.sourceType||'未知']=(g[s.sourceType||'未知']||0)+1,g),{})};
 manifest.selections=manifest.selections.filter(s=>!s.isAnswer).map(s=>{const ref=s.sourceRef?.match(/^([a-f0-9-]{36})@(\d+)#([^/]+)\/(.+)$/);return ref?{...s,objectId:s.objectId||ref[1],version:s.version??Number(ref[2]),blockId:s.blockId||ref[3],componentId:s.componentId||ref[4]}:s;});
 return manifest;
}
const hash=text=>createHash('sha256').update(text).digest('hex');
export function createOntologyReader({env=process.env,transport=fetch}={}){
 // Product credentials are supplied by the deployment, never borrowed from the
 // assistant's agent.token or sent to the browser. No credential file is read.
 const token=env.TKOS_WORLD_PRODUCT_TOKEN;
 return {ready:Boolean(token),async get(path){
  if(!token)throw Object.assign(Error('产品服务尚未接收本体专用只读凭证；Codex已读通不等于产品已接通。请完成产品凭证交接后重试。'),{status:503,code:'ONTOLOGY_CREDENTIAL_MISSING'});
  if(!/^\/v1\/world\/objects\/[a-f0-9-]{36}(?:\/events)?$/.test(path))throw Error('本体读取路径不允许');
  let r;try{r=await transport(new URL(path,'https://world-02.tokenkingos.com'),{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`}});}catch{throw Object.assign(Error('本体服务连接失败；未退回模拟或飞书数据'),{status:503});}
  if(!r.ok)throw Object.assign(Error(`本体读取返回${r.status}；未更换身份或使用缓存`),{status:[401,403,404].includes(r.status)?r.status:503});
  const value=await r.json();return value.data||value;
 }};
}
export async function fetchOntologySources({reader=createOntologyReader(),manifest,onProgress=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 manifest??=await loadOntologyManifest();
 const cache=new Map();
 const paths=[...new Set(manifest.selections.map(s=>`/v1/world/objects/${s.objectId}${s.eventId?'/events':''}`))];
 const retries=[];
 // A version that moved on is not an error: a recorded version never changes, so the reviewed text stands; the newer one is reported.
 const versionNotices=new Map();
 // Month goals are read as they stood at the cutoff (version and draft/committed); a later status change is only reported.
 const statusNotices=new Map();
 const verify=(s,object)=>{
  if(!object||typeof object!=='object')throw Object.assign(Error('本体没有返回对象：'+s.sourceRef),{status:409,diagnostics:{reason:'source-not-readable',sourceRef:s.sourceRef,unitKey:s.unit}});
  let source;
  if(s.eventId)source=object.events?.find(e=>e.event_id===s.eventId)?.content?.text;
  else if(s.identityNames){const names=object.identity?.responsible?.principals?.map(p=>p.display_name).sort();if(JSON.stringify(names)!==JSON.stringify([...s.identityNames].sort()))throw Object.assign(Error('责任信息发生变化，请重新核对：'+s.unit),{status:409});return s;}
  else {
   if(s.lifecycleStatus){const live=object.records?.lifecycle?.status;if(live&&live!==s.lifecycleStatus)statusNotices.set(s.objectId,{unit:s.unit,title:s.title||s.kind,objectId:s.objectId,statusAtCutoff:s.lifecycleStatus,latestStatus:live});}
   const b=(object.business?.blocks||object.blocks||object.snapshot?.blocks)?.find(b=>b.id===s.blockId);source=s.componentId?(b?.components||b?.value?.components)?.find(c=>c.id===s.componentId)?.text:b?.text;
   if(s.version!==undefined&&object.business?.version!==s.version){
    if(!(object.business?.version>s.version)||typeof s.text!=='string'||!s.text.trim())throw Object.assign(Error('基线版本发生变化，请重新选择：'+s.unit),{status:409});
    // A version pinned at the cutoff is deliberate (later versions are the DRI's own answer), so it is not offered as an update.
    if(!s.pinnedAtCutoff)versionNotices.set(s.id,{unit:s.unit,title:s.title||s.kind,sourceRef:s.sourceRef,usedVersion:s.version,latestVersion:object.business.version});
    return s;
   }}
  const actualHash=typeof source==='string'?hash(source):null;
  // Events are append-only, so an approved event id is read as it stands and its hash recorded for provenance.
  if(s.readLive&&s.eventId&&typeof source==='string'){s.text=source;s.sourceHash=actualHash;return s;}
  if(typeof source!=='string'||actualHash!==s.sourceHash||!source.includes(s.text)){
   const reason=typeof source!=='string'?'source-not-readable':actualHash!==s.sourceHash?'source-hash-changed':'selected-text-not-found';
   throw Object.assign(Error(`本体来源核对失败：${s.unit} · ${s.title||s.kind} · ${s.sourceRef}；${reason==='source-not-readable'?'原引用没有读到文本':reason==='source-hash-changed'?'原文与已审查版本不同':'原文不再包含已选片段'}；未使用旧缓存`),{status:409,diagnostics:{stage:'source-verification',reason,unitKey:s.unit,selectionId:s.id,sourceRef:s.sourceRef,objectId:s.objectId,eventId:s.eventId||null,blockId:s.blockId||null,componentId:s.componentId||null,expectedHash:s.sourceHash,actualHash}});
  }
  return s;
 };
 const readVerified=async path=>{
  const selections=manifest.selections.filter(s=>`/v1/world/objects/${s.objectId}${s.eventId?'/events':''}`===path);
  for(let attempt=1;attempt<=3;attempt++){
   try{const object=await reader.get(path);for(const s of selections)verify(s,object);cache.set(path,object);return;}
   catch(error){
    const retryable=error.code!=='ONTOLOGY_CREDENTIAL_MISSING'&&(error.status===409||[408,429,500,502,503,504].includes(error.status)||transientRoundFailure(error));
    if(!retryable||attempt===3){if(retryable)error.code='ONTOLOGY_RETRIES_EXHAUSTED';error.diagnostics={...error.diagnostics,path,attempts:attempt,retries:structuredClone(retries)};throw error;}
    retries.push({path,attempt,reason:error.diagnostics?.reason||error.message});
    await onProgress(cache.size,paths.length,{retry:{path,attempt:attempt+1,attempts:3,reason:error.diagnostics?.reason||error.message}});
    await sleep(1000*2**(attempt-1));
   }
  }
 };
 for(let i=0;i<paths.length;i+=3){const results=await Promise.allSettled(paths.slice(i,i+3).map(readVerified));const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;await onProgress(cache.size,paths.length);}
 const facts=manifest.selections.map(s=>verify(s,cache.get(`/v1/world/objects/${s.objectId}${s.eventId?'/events':''}`)));
 const selected=buildGeneratorInput(facts,{period:manifest.period,cutoff:manifest.cutoff,excludedTypes:['PeriodGoal','Mission','Task','Activity']});
 if(selected.audit.pending.length||selected.audit.excluded.length)throw Object.assign(Error('已审查输入未通过过滤，停止本轮生成'),{status:409});
 const keys=['company','bf01','bf02','bf03','rearch','method','agents','eo','tokenhub','talent','finance',...(selected.sources.some(s=>s.unit==='organization')?['organization']:[])];
 if(keys.filter(key=>key!=='organization').some(key=>!selected.sources.some(s=>s.unit===key&&s.kind==='lto')))throw Object.assign(Error('公司或责任单元缺少有效LTO，无法生成整轮'),{status:409});
 const sources=keys.map(key=>{const items=selected.sources.filter(s=>s.unit===key);// This month's intent is marked in the text the model reads, so the skill can name it without field names.
 const content=items.map(s=>`${s.kind==='intent'?'【本月意图】':''}${s.title||s.kind} · ${s.sourceRef} · ${s.confirmation}${s.factThrough?' · 事实截至'+s.factThrough:''}\n${s.text}`).join('\n\n');return {key,title:key,content,hash:hash(content),revision:manifest.version,factRefs:items.map(s=>s.sourceRef),facts:items};});
 // Public audit contains only safe gap descriptions, not quarantined raw answers.
 return {mode:'ontology-selected-facts',period:manifest.period,cutoff:manifest.cutoff,planningDate:manifest.planningDate,retrievedAt:new Date().toISOString(),sources,capacity:manifest.capacity,audit:{pending:manifest.pending,accepted:facts.length,reviewVersion:manifest.version,sourceRetries:retries,...(manifest.answerExclusions?{excludedAnswers:manifest.answerExclusions}:{})},versionNotices:[...versionNotices.values()],statusNotices:[...statusNotices.values()],model:null};
}
const codexBatch=15;
export async function fetchCodexOntologySources({onProgress=()=>{}}={}){
 const manifest=await loadOntologyManifest();
 const paths=[...new Set(manifest.selections.map(s=>`/v1/world/objects/${s.objectId}${s.eventId?'/events':''}`))];
 let responses;
 // One Codex run stops early on a long list (2026-10-21: the November manifest's 69 objects read 0–1 of 69, five read fine), so read in batches.
 try{responses=new Map();for(let i=0;i<paths.length;i+=codexBatch){const batch=paths.slice(i,i+codexBatch);
  const part=await retryRoundCall(()=>readThroughCodex(batch,{onProgress:(done,total,meta)=>onProgress(i+done,paths.length,meta),timeoutMs:180000}),{onRetry:retry=>onProgress(i,paths.length,{retry})});
  for(const [k,v] of part)responses.set(k,v);}}
 catch(error){if(transientRoundFailure(error)){error.code='ONTOLOGY_RETRIES_EXHAUSTED';error.diagnostics={...error.diagnostics,stage:'source-transport',attempts:3};}throw error;}
 const consumed=new Set();
 const input=await fetchOntologySources({manifest,onProgress,reader:{get:async p=>{
  if(!consumed.has(p)){consumed.add(p);return responses.get(p);}
  // A verification retry must reread the source, not the initial response map.
  const fresh=await readThroughCodex([p],{timeoutMs:60000});return fresh.get(p);
 }}});
 return {...input,transport:'codex-mcp-read-only',notes:manifest.notes};
}
export async function fetchDeploymentOntologySources(options){
 if(process.env.DECODING_USE_CODEX_BRIDGE==='1'&&process.env.NODE_ENV!=='production')return fetchCodexOntologySources(options);
 return fetchOntologySources(options);
}
export async function ontologyConnectionStatus(reader){
 reader??=process.env.DECODING_USE_CODEX_BRIDGE==='1'&&process.env.NODE_ENV!=='production'?undefined:createOntologyReader();
 const manifest=await loadOntologyManifest();
 const connection=reader?{configured:reader.ready,message:reader.ready?'已配置产品凭证':'待交接产品专用只读凭证'}:await codexBridgeStatus();
 return {...connection,period:manifest.period,cutoff:manifest.cutoff,reviewVersion:manifest.version,selectedFacts:manifest.selections.length,gaps:manifest.pending};
}
