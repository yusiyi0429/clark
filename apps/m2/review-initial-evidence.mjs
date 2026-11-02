import {createHash} from 'node:crypto';
import {reviewModelBudgetBytes} from './review-source-plan.mjs';
import {citationFacts} from './review-evidence-addresses.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const initialEvidenceContract=()=>({version:1,mode:'frozen-explicit-evidence',maxRetrievals:1,maxPhysicalAttempts:3,maxRecords:64,maxEvidenceBytes:256*1024,maxBodyBytes:512*1024,responseReserveBytes:4096,maxQueryChars:128});
export function validateInitialEvidence(input){const c=input.engineeringContracts?.initialEvidence;if(c!==undefined&&hash(c)!==hash(initialEvidenceContract()))throw Error('初稿显式取证合同不受支持');return c;}
export function initialEvidenceSetup({input,card,user}){
 const contract=validateInitialEvidence(input);
 if(!contract||card.level!=='mission')return {user};
 const items=input.stages.flat(),byRef=new Map(items.map(c=>[c.id,c])),labels=[],labelIndex=new Map(),label=s=>{if(!labelIndex.has(s)){labelIndex.set(s,labels.length);labels.push(s);}return labelIndex.get(s);};
 const sourceCatalog=items.map(c=>({sourceRef:c.id,objectId:c.objectId,sourceBasis:c.sourceBasis||null,title:c.title,owner:c.owner,parent:c.parent,evidenceCount:c.evidence.length}));
 const evidenceDirectory={fields:['id','asOf','sourceLabelIndex'],sourceLabels:labels,sources:items.map(c=>({sourceRef:c.id,records:c.evidence.map(e=>[e.id,e.asOf??null,label(e.source??null)])}))};
 const base={...user,sourceCatalog,evidenceDirectory,evidenceRetrieval:structuredClone(contract),task:user.task+' 目录仅用于发现同轮冻结来源，不是事实证据，不代表已读原文。若需跨源核实，可返回 requestEvidence:{addresses:[{sourceRef,id}],query:可选字面查询,sourceRefs:可选查询范围,from:可选YYYY-MM-DD,to:可选YYYY-MM-DD}，最多一次取证往返。日期仅按原asOf真实字段含首尾筛选，缺日期明确列出，不猜发生时间。程序按冻结顺序返回完整E记录、实际已给地址/未给地址及命中数；不是语义归属。同词或他人/单元级记录不自动成为本Mission成果。仅已给unit原文和取回完整记录能作依据，跨源引用保留[sourceRef:EID]。最终必须基于已拿资料返回review，如实保留资料缺口，不能把未读写成未发生。'};
 const finalize=user=>user.evidenceRetrieval.finalizeOnly?user:({...user,evidenceRetrieval:{...user.evidenceRetrieval,finalizeOnly:true},task:user.task+' 本次为最终初稿：不再请求取证；只根据已经实际提供的原文返回review，未拿到的资料如实保留缺口。'});
 const supplied=new Set((card.evidence||[]).map(e=>card.id+':'+e.id));
 const flow={contract,finalize,validateReview(review,requestUser){
  const actual=new Set([...supplied,...(requestUser.evidenceResponse?.records||[]).map(r=>r.sourceRef+':'+r.id)]);
  for(const a of citationFacts(review,{sourceRef:card.id,sources:Object.fromEntries(byRef)}).addresses)if(a.valid&&!actual.has(a.key))throw Error('初稿引用的完整证据尚未实际提供，目录不能作为证据');
 },resolve(value,{system,wireOptions}){
  const request=value?.requestEvidence;
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['addresses','query','sourceRefs','from','to'].includes(k)))throw Error('取证请求必须显式列出地址或字面查询');
  const addresses=request.addresses??[],query=request.query??'',scope=request.sourceRefs??items.map(c=>c.id);
  if(!Array.isArray(addresses)||addresses.some(a=>!a||Object.keys(a).some(k=>!['sourceRef','id'].includes(k))||!byRef.has(a.sourceRef)||!byRef.get(a.sourceRef).evidence.some(e=>e.id===a.id))||new Set(addresses.map(a=>a.sourceRef+':'+a.id)).size!==addresses.length||typeof query!=='string'||query.length>contract.maxQueryChars||!Array.isArray(scope)||!scope.length||new Set(scope).size!==scope.length||scope.some(ref=>!byRef.has(ref))||!addresses.length&&!query.trim())throw Error('取证请求地址、范围或字面查询不符合冻结合同');
  const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(request.from!==undefined&&!day(request.from)||request.to!==undefined&&!day(request.to)||request.from&&request.to&&request.from>request.to)throw Error('取证日期范围无效');
  const missingDate=[];
  const selected=new Map();for(const a of addresses)selected.set(a.sourceRef+':'+a.id,{sourceRef:a.sourceRef,evidence:byRef.get(a.sourceRef).evidence.find(e=>e.id===a.id)});
  if(query.trim())for(const c of items)if(scope.includes(c.id))for(const e of c.evidence)if([e.text,e.source].some(s=>String(s||'').toLowerCase().includes(query.toLowerCase()))){
   const asOf=typeof e.asOf==='string'?e.asOf.slice(0,10):null;
   if((request.from||request.to)&&!day(asOf)){missingDate.push({sourceRef:c.id,id:e.id,reason:'missing-valid-asOf'});continue;}
   if(request.from&&asOf<request.from||request.to&&asOf>request.to)continue;
   selected.set(c.id+':'+e.id,{sourceRef:c.id,evidence:e});
  }
  const records=[],notProvided=[],alreadyProvided=[];let size=0;
  for(const [key,{sourceRef,evidence}]of selected){const address={sourceRef,id:evidence.id};if(supplied.has(key)){alreadyProvided.push(address);continue;}
   const c=byRef.get(sourceRef),record={...address,objectId:c.objectId,sourceBasis:c.sourceBasis||null,evidenceHash:hash(evidence),evidence};
   const bytes=Buffer.byteLength(JSON.stringify(record));if(records.length>=contract.maxRecords||size+bytes>contract.maxEvidenceBytes){notProvided.push({...address,reason:'retrieval-budget'});continue;}records.push(record);size+=bytes;
  }
  const response={query,requestedAddresses:addresses,querySourceRefs:scope,...(request.from?{from:request.from}:{}),...(request.to?{to:request.to}:{}),excludedMissingDate:missingDate,matchedCount:selected.size,records,providedAddresses:records.map(({sourceRef,id})=>({sourceRef,id})),alreadyProvided,notProvided,selection:'literal-match-not-attribution',frozen:true};
  let bodyResponse=response;
  const next=()=>finalize({...base,evidenceResponse:bodyResponse});
  while(reviewModelBudgetBytes(system,next(),wireOptions)>contract.maxBodyBytes&&records.length){const removed=records.pop();notProvided.push({sourceRef:removed.sourceRef,id:removed.id,reason:'request-body-budget'});response.providedAddresses=records.map(({sourceRef,id})=>({sourceRef,id}));}
  if(reviewModelBudgetBytes(system,next(),wireOptions)>contract.maxBodyBytes)bodyResponse={matchedCount:response.matchedCount,records:[],providedAddresses:[],notProvidedCount:response.notProvided.length,notProvidedAddressesOmitted:true,notProvidedAddressSetHash:hash(response.notProvided),reason:'request-body-budget',frozen:true};
  if(reviewModelBudgetBytes(system,next(),wireOptions)>contract.maxBodyBytes)throw Object.assign(Error('最终初稿完整请求超过预留预算，未调用或截断原文'),{code:'REVIEW_PACKET_OVERSIZE'});
  return {user:next(),response};
 }};
 return {user:base,evidenceFlow:flow};
}
