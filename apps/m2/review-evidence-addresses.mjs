// One machine citation grammar for measurement, verification and presentation.
// A namespace is never discarded before looking up its evidence identifier.
const marker=/\[(?:([^\s:\[\]]+):)?(E\d+)\]/g;
export function evidenceAddresses(text,{sourceRef,sources}={}){
 return [...String(text||'').matchAll(/\[[^\[\]\r\n]+\]/g)].filter(m=>/E\d+/.test(m[0])).map(m=>{const parsed=/^\[(?:([^\s:\[\]]+):)?(E\d+)\]$/.exec(m[0]);if(!parsed)return {raw:m[0],key:'invalid:'+m[0],valid:false};const ref=parsed[1]||sourceRef,id=parsed[2];return {raw:m[0],ref,id,key:`${ref}:${id}`,valid:!!ref&&Object.hasOwn(sources||{},ref)&&(sources[ref].evidence||[]).some(e=>e.id===id)};});
}
export function stripVerifiedEvidence(text,context){return String(text||'').replace(marker,(raw,ref,id)=>evidenceAddresses(raw,context)[0]?.valid?'':raw);}
export function citationFacts(review,context){
 const found=new Map();
 const visit=value=>{if(typeof value==='string'){for(const address of evidenceAddresses(value,context))found.set(address.raw,address);}else if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')for(const [key,part] of Object.entries(value))if(!['evidenceReferenceMap','questionRoute','questionCoverBindings'].includes(key))visit(part);};
 visit(review);
 if(review?.evidenceRefs!==undefined&&!Array.isArray(review.evidenceRefs))found.set('evidenceRefs',{raw:'[evidenceRefs]',key:'invalid:evidenceRefs',valid:false});
 for(const address of Array.isArray(review?.evidenceRefs)?review.evidenceRefs:[])if(typeof address==='string')visit(address.startsWith('[')?address:`[${address}]`);else if(address&&typeof address.ref==='string'&&typeof address.id==='string')visit(`[${address.ref}:${address.id}]`);else found.set('evidenceRefs',{raw:'[evidenceRefs]',key:'invalid:evidenceRefs',valid:false});
 return {missingIds:[...found.values()].filter(a=>!a.valid).map(a=>a.raw.slice(1,-1)),usedCount:new Set([...found.values()].map(a=>a.key)).size,addresses:[...found.values()]};
}
export function verifiedReferenceMap(review,context){return Object.fromEntries(citationFacts(review,context).addresses.filter(a=>a.valid).map(a=>[a.raw,{ref:a.ref,id:a.id}]));}
export function referenceMapsForInput(input,reviews){
 if(input?.engineeringContracts?.evidenceAddresses!==1)return undefined;
 const sources=Object.fromEntries(input.stages.flat().map(c=>[c.id,c]));
 return Object.fromEntries(Object.entries(reviews).map(([ref,review])=>[ref,verifiedReferenceMap(review,{sourceRef:ref,sources})]));
}
export function validateIssueSources(issue,{sources,providedRefs,checkerSources=2,requireTarget=true}){
 if(!Array.isArray(issue.sourceRefs)||!issue.sourceRefs.length||requireTarget&&!issue.sourceRefs.includes(issue.ref)||new Set(issue.sourceRefs).size!==issue.sourceRefs.length||issue.sourceRefs.some(ref=>!providedRefs.includes(ref)||!Object.hasOwn(sources,ref)))throw Error(requireTarget?'检查意见必须显式列出目标与实际所用的完整来源sourceRefs':'检查意见的 sourceRefs 必须列出本次实际提供并使用的原文');
 if(issue.evidenceRefs!==undefined){if(!Array.isArray(issue.evidenceRefs))throw Error('检查证据地址必须是ref/id对象列表');for(const a of issue.evidenceRefs){if(!a||typeof a.ref!=='string'||!/^E\d+$/.test(a.id||'')||!issue.sourceRefs.includes(a.ref)||(sources[a.ref]?.evidence||[]).every(e=>e.id!==a.id))throw Error('检查意见的证据地址不属于声明的冻结原文');}}
 // Only explicit machine addresses are compared. Plain-language mentions never
 // create dependencies, and missing declarations are rejected rather than guessed.
 // V3 removes only redundant membership in optional evidenceRefs. Invalid
 // addresses in problem/impact may be the error being reported; keep the old
 // boundary rather than infer whether prose uses them as supporting evidence.
 for(const text of [issue.problem,issue.impact])for(const a of evidenceAddresses(text,{sourceRef:issue.ref,sources}).filter(a=>a.valid))if(!issue.sourceRefs.includes(a.ref)||checkerSources<3&&issue.evidenceRefs&&!issue.evidenceRefs.some(e=>e.ref===a.ref&&e.id===a.id))throw Error('检查意见的机器地址与结构化来源声明不一致');
 return issue;
}
