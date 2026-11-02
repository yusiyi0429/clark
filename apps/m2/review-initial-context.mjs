import {createHash} from 'node:crypto';
import {citationFacts} from './review-evidence-addresses.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const parentInitialContextContract=()=>({version:1,sourceMode:'cited-child-evidence',maxBodyBytes:512*1024});
export function validateInitialContext(input){
 const contract=input.engineeringContracts?.initialContext;
 if(contract!==undefined&&hash(contract)!==hash(parentInitialContextContract()))throw Error('父级初稿来源或预算合同不受支持');
 return contract;
}
export function parentInitialPayload({input,card,user,reviews,sourceFor}){
 const contract=validateInitialContext(input);
 if(!contract||!['ru','company'].includes(card.level)||!card.children?.length)return {user};
 const items=new Map(input.stages.flat().map(c=>[c.id,c])),sourceRefs=[card.id,...card.children];
 if(new Set(sourceRefs).size!==sourceRefs.length||sourceRefs.some(ref=>!items.has(ref))||card.children.some(ref=>!reviews[ref]))throw Error('父级初稿缺少完整直接子项来源或当前子候选');
 const sources=Object.fromEntries([...items].map(([ref,c])=>[ref,sourceFor(c)])),records=new Map(),bindings=[],missingAddresses=[];
 for(const ref of card.children)for(const a of citationFacts(reviews[ref],{sourceRef:ref,sources}).addresses){
  if(!a.valid){missingAddresses.push({childRef:ref,raw:a.raw});continue;}
  const source=sources[a.ref],evidence=source.evidence.find(e=>e.id===a.id);
  records.set(a.key,{sourceRef:a.ref,id:a.id,objectId:source.objectId,sourceBasis:source.sourceBasis||null,evidenceHash:hash(evidence),evidence});
  bindings.push({childRef:ref,raw:a.raw,sourceRef:a.ref,id:a.id});
 }
 const childCandidates=card.children.map(ref=>({ref,candidate:true,confirmed:false,reviewHash:hash(reviews[ref]),sourceRef:ref,sourceBasis:sources[ref].sourceBasis||null}));
 return {user:{...user,
  task:user.task+' childEvidence只提供子候选中已出现且可核实地址的完整E原文，不代表读过全部子项原文。bindings按各子候选自己的ref解析裸[E3]，不能套用父层同编号。missingAddresses未核实，不得猜证据。子候选仍是本轮候选，不是正式确认或原始事实；必须核对所给原文的时间、出处和归属。父层引用子项证据使用[sourceRef:E3]，裸[E3]仍只指本层unit。',
  initialContext:structuredClone(contract),childCandidates,
  childEvidence:{mode:'only-cited-full-evidence-not-complete-child-source',records:[...records.values()],bindings,missingAddresses},
 }};
}
