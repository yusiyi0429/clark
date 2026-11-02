import {redactText} from './redact.mjs';
import {createHash} from 'node:crypto';
import {memberProfiles} from './member-profiles.mjs';
import {roomOf} from './governance.mjs';
const clone=structuredClone,same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const evidenceHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const jobId=round=>String(round?.source||'').match(/^生成任务 ([a-f0-9-]{36})$/)?.[1]||null;
const names=value=>String(value||'').split(/[、,，\s]+/).filter(Boolean);
const factText=f=>({ref:f?.ref||'',item:f?.item||'',owner:f?.owner||'',evidence:f?.evidence||'',gap:f?.gap||''});
const keyOf=c=>c?.objectId||c?.sourceBasis?.objectId;
// No chat body, private Agent text, insight, verdict or status is captured here.
const rowAt=(version,ref)=>{const matches=(version?.content?.facts||[]).filter(f=>f.ref===ref);return matches.length===1?matches[0]:null;};
const sameReport=(a,b)=>!!a&&!!b&&same({...factText(a),status:a.status},{...factText(b),status:b.status});
const sourceIdentity=content=>({objectId:keyOf(content),owner:content.owner,sourceBasis:content.sourceBasis,agreedBasis:content.agreedOutcome?.sourceBasis});
function validSigner(version,card){
 const slot=card.level==='company'?'ceo':card.level==='po'?'unitDri':'missionDri';
 return (version.signatures||[]).find(s=>s.version===version.number&&s.slot===slot&&names(version.content.owner).includes(memberProfiles[s.actorId]?.name)&&Number.isFinite(Date.parse(s.createdAt))&&Date.parse(s.createdAt)>=Date.parse(version.createdAt));
}
export function captureConfirmedFacts(state,{period,now=new Date().toISOString()}={}){
 const entries=[],excluded=[],snapshots=[...(state.reviewArchives||[]).filter(a=>Array.isArray(a.cards)).map(a=>({round:a.round,cards:a.cards,messages:a.messages||[],comments:a.comments||[]})),{round:state.reviewRound,cards:Object.values(state.cards||{}),messages:state.messages||[],comments:state.comments||[]}];
 const newestCards=new Map();
 for(const snapshot of snapshots){if(snapshot.round?.period!==period||snapshot.round.sample===true)continue;for(const card of snapshot.cards.filter(c=>c.kind==='review')){const latest=card.versions?.at(-1),objectId=keyOf(latest?.content);if(!objectId){if(card.confirmedVersion)excluded.push({cardId:card.id,reason:'旧已确认卡缺明确本体objectId，未按标题猜配'});continue;}if(!card.confirmedVersion&&card.versions?.length===1)continue;const time=Math.max(Date.parse(latest?.createdAt)||0,...(latest?.signatures||[]).map(s=>Date.parse(s.createdAt)||0)),old=newestCards.get(objectId);if(!old||time>old.time)newestCards.set(objectId,{snapshot,card,time});}}
 for(const {snapshot,card} of newestCards.values()){
  const {round}=snapshot,latest=card.versions.at(-1),content=latest.content,objectId=keyOf(content);
  const reject=(reason,ref)=>excluded.push({cardId:card.id,objectId,ref,round:round.source||round.loadedAt,reason});
  if(card.withdrawn||card.cancelled||content.withdrawn||content.cancelled){reject('旧卡已撤掉或取消');continue;}
  if(!card.confirmedVersion){reject('缺本人有效确认版本，未签新稿不作为已确认报告');continue;}
  if(!Array.isArray(content.facts)){reject('旧版缺可对应的事实条目');continue;}
  if(new Set(content.facts.map(f=>f.ref)).size!==content.facts.length){reject('旧事实ref重复，未猜对应');continue;}
  const signed=card.versions.filter(v=>v.number<=card.confirmedVersion&&validSigner(v,card)).reverse();
  if(!signed.length){reject('缺正确署名人对确切版本的有效确认');continue;}
  const refs=new Set([...content.facts,...signed.flatMap(v=>v.content.facts||[])].map(f=>f.ref));
  for(const ref of refs){
   if(!ref){reject('旧事实缺明确ref');continue;}
   const confirmed=signed.find(v=>{const row=rowAt(v,ref),start=card.versions.indexOf(v);return row&&card.versions.slice(start).every(later=>same(sourceIdentity(later.content),sourceIdentity(v.content))&&sameReport(rowAt(later,ref),row));});
   if(!confirmed){reject('后续未确认修订已改变、删除或撤回此项事实，未沿用历史确认',ref);continue;}
   const fact=rowAt(confirmed,ref),signer=validSigner(confirmed,card),sourceJobId=jobId(round),namespace=`m2:${period}:${sourceJobId||round.loadedAt}:${card.id}:v${confirmed.number}`;
   let origin=confirmed;
   for(let i=card.versions.indexOf(confirmed)-1;i>=0;i--){const previous=card.versions[i];if(!sameReport(rowAt(previous,ref),fact))break;origin=previous;}
   const text=factText(fact);if(!text.evidence.trim()||/^(?:达成|未达成|部分达成|已完成)[。！!\s]*$/.test(text.evidence)){reject('旧事实只有空文或结果标签，没有具体事实报告',ref);continue;}
   const inlineSourceIds=[...new Set((text.evidence+' '+text.gap).match(/event-\d+/g)||[])],sourceIds=[...new Set([...(origin.evidenceIds||[]),...inlineSourceIds])];
   const sources=sourceIds.map(id=>{const e=[...snapshot.messages,...snapshot.comments].find(e=>e.id===id&&e.channel==='group'&&e.scope===roomOf(card));return {id,...(e?{authorId:e.author,recordedAt:e.createdAt,room:e.scope,originalCardId:e.cardId}:{unresolved:true})};});
   entries.push({objectId,level:card.level,owner:confirmed.content.owner,ownerAssigned:confirmed.content.ownerAssigned!==false,cardId:card.id,reviewVersion:confirmed.number,latestReviewVersion:latest.number,historicalConfirmed:confirmed.number!==latest.number,roundSource:round.source,sourceJobId,namespace,period,confirmedBy:signer.actorId,confirmedAt:signer.createdAt,revisionAuthorId:origin.author,revisionVersion:origin.number,revisionRecordedAt:origin.createdAt,sourceIds,sources,fact:text});
  }
 }
 const newest=new Map();for(const e of entries){const key=e.objectId+'|'+e.fact.ref,old=newest.get(key);if(!old||Date.parse(e.confirmedAt)>Date.parse(old.confirmedAt))newest.set(key,e);}
 const bundle={schemaVersion:1,period,capturedAt:now,entries:[...newest.values()],excluded};return {...bundle,hash:evidenceHash(bundle)};
}
export function verifyEvidenceBundle(bundle){const {hash,...value}=bundle||{};if(!hash||evidenceHash(value)!==hash)throw Error('已确认人工事实冻结校验失败，不能混入变化后的来源');}
function modelValue(value,hits){
 if(typeof value==='string'){const redacted=redactText(value);for(const [name,count]of Object.entries(redacted.hits))hits[name]=(hits[name]||0)+count;return redacted.text;}
 if(Array.isArray(value))return value.map(v=>modelValue(v,hits));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,modelValue(v,hits)]));
 return value;
}
const taskTerms=t=>Object.fromEntries(['ref','title','expected','quality','finish','owner'].map(k=>[k,t?.[k]||'']));
function recordedVersion(input,id){
 const versions=[...new Set((input.readReceipt?.objects||[]).filter(r=>r.startsWith(id+'@')).map(r=>r.slice(id.length+1)))];
 return versions.length===1&&/^\d+$/.test(versions[0])?Number(versions[0]):null;
}
function definitionTerms(text){
 const section=String(text).split('【任务定义】')[1]?.split(/\n【/)[0];if(!section)return null;
 const read=label=>section.split('\n').filter(line=>line.startsWith('- '+label+'：')).map(line=>line.slice(label.length+3)).join('；');
 return {expected:read('成果'),quality:read('成功标准'),finish:read('time_boundary')};
}
export function taskSourceCompatibility(before,after,oldCard,card,oldInput,input){
 if(same(taskTerms(before),taskTerms(after)))return {mode:'exact-fields'};
 const id=before.ref,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 if(!uuid.test(id)||after.ref!==id||after.objectId!==id||after.parentRef!==card.objectId||before.owner!==after.owner)return null;
 const version=recordedVersion(oldInput,id),goalVersion=recordedVersion(oldInput,card.objectId),plan=after.planSource;
 if(!version||version!==after.version||recordedVersion(input,id)!==version||!goalVersion||goalVersion!==card.sourceBasis?.sourceVersion||recordedVersion(input,card.objectId)!==goalVersion)return null;
 if(!before.definition||before.definition!==after.definition||!plan||plan.sourceVersion!==goalVersion||!plan.sourceRevision||plan.sourceRevision!==card.sourceBasis.sourceRevision)return null;
 if(before.title!==after.planTitle||before.title!==plan.title||!after.title||!['：',':'].some(separator=>before.title.startsWith(after.title+separator)))return null;
 if(!after.componentRef?.startsWith(`${card.objectId}@${goalVersion}#execution_plan/`)||plan.componentRef!==after.componentRef||plan.ref!==after.commitmentRef||after.commitmentRef!==after.componentRef.replace(/@\d+#/,'#'))return null;
 const terms=definitionTerms(before.definition);if(!terms)return null;
 for(const field of ['expected','quality','finish'])if((after[field]||'')!==terms[field]||before[field]&&before[field]!==after[field])return null;
 return {mode:'same-object-reader-projection',objectId:id,objectVersion:version,parentObjectId:card.objectId,parentVersion:goalVersion,parentRevision:plan.sourceRevision,componentRef:after.componentRef,definitionHash:evidenceHash(before.definition),planTextHash:evidenceHash(before.title)};
}
export function addConfirmedFacts(input,bundle,sourceInputs){
 verifyEvidenceBundle(bundle);if(bundle.period!==input.period)throw Error('人工事实冻结周期不一致');
 const out=clone(input),receipt={sourceHash:bundle.hash,accepted:[],excluded:clone(bundle.excluded)};
 for(const rejected of bundle.excluded){const card=out.stages.flat().find(c=>c.objectId===rejected.objectId);if(card)(card.m2EvidenceReceipt??={accepted:[],excluded:[]}).excluded.push(clone(rejected));}
 for(const e of bundle.entries){
  const exclude=reason=>{const rejected={objectId:e.objectId,cardId:e.cardId,ref:e.fact.ref,namespace:e.namespace,reason};receipt.excluded.push(rejected);const target=out.stages.flat().find(c=>c.objectId===e.objectId);if(target)(target.m2EvidenceReceipt??={accepted:[],excluded:[]}).excluded.push(rejected);};
  const candidates=out.stages.flat().filter(c=>c.objectId===e.objectId);if(candidates.length!==1){exclude('当前对象不存在或不唯一，未套用旧事实');continue;}
  const card=candidates[0];if(card.period!==e.period||!same(names(card.owner).sort(),names(e.owner).sort())){exclude('周期或署名人变化');continue;}
  const oldInput=e.sourceJobId&&sourceInputs[e.sourceJobId],oldCards=oldInput?.stages?.flat().filter(c=>c.objectId===e.objectId)||[];
  if(oldInput?.period!==e.period||oldCards.length!==1){exclude('缺旧任务冻结输入或对象不唯一，无法核承诺相容');continue;}
  const old=oldCards[0];if(old.commitment!==card.commitment){exclude('目标承诺正文已变化，未套旧事实');continue;}
  const previousTasks=(old.tasks||old.expectedFacts||[]).filter(t=>t.ref===e.fact.ref),currentTasks=(card.tasks||card.expectedFacts||[]).filter(t=>t.ref===e.fact.ref);
  const compatibility=previousTasks.length===1&&currentTasks.length===1?taskSourceCompatibility(previousTasks[0],currentTasks[0],old,card,oldInput,input):null;
  if(!compatibility){exclude('Task身份、条款或署名不相容/有歧义');continue;}
  const legacyIds=[...new Set((e.fact.evidence+' '+e.fact.gap).match(/\bE\d+\b/g)||[])],legacyEvidence=legacyIds.map(id=>{const source=(old.evidence||[]).find(x=>x.id===id);return {id,namespace:e.namespace,...(source?{source:clone(source)}:{unresolved:true})};});
  const id='E'+(Math.max(0,...card.evidence.map(x=>Number(String(x.id).match(/^E(\d+)$/)?.[1])||0))+1);
  // The original quotation remains byte-for-byte intact. Legacy E numbers are
  // namespaced separately and never resolved against this round's evidence list.
  const redactions={},evidence=modelValue({id,kind:'负责人报告',source:`旧M2署名人确认的事实报告 · ${e.cardId} v${e.reviewVersion} · 原文E编号仅指旧来源 ${e.namespace}`,asOf:String(e.confirmedAt||'').slice(0,10),text:e.fact.evidence,reportedGap:e.fact.gap,factRef:e.fact.ref,factItem:e.fact.item,m2Source:{...clone(e),compatibility,legacyEvidence,independentVerification:false,sourceOwnerAssigned:e.ownerAssigned,currentOwnerAssigned:card.ownerAssigned!==false,worldAssignmentVerified:false,originalQuoteHash:evidenceHash(e.fact)}},redactions);
  if(Object.keys(redactions).length){evidence.redactions=redactions;card.redactions??={};for(const [name,count]of Object.entries(redactions))card.redactions[name]=(card.redactions[name]||0)+count;(out.redactions??={})[card.id]=clone(card.redactions);}
  card.evidence.push(evidence);
  const accepted={objectId:e.objectId,cardId:card.id,ref:e.fact.ref,evidenceId:id,namespace:e.namespace,sourceIds:e.sourceIds};receipt.accepted.push(accepted);(card.m2EvidenceReceipt??={accepted:[],excluded:[]}).accepted.push(accepted);
 }
 out.m2ConfirmedEvidence={...receipt,sourceInputsHash:evidenceHash(sourceInputs)};return out;
}
