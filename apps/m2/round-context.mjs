import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Only reviewed projections enter the calls. Never raw packs or old answers.
export function domainContext(input,key){
 const rank=k=>k===key?0:k==='company'?1:k==='organization'?2:3;
 return structuredClone([...input.sources].sort((a,b)=>rank(a.key)-rank(b.key)).map(({facts,...source})=>source));
}
export function inputCoverage(input){
 const facts=input.sources.flatMap(s=>s.facts||[]);
 return {sourceCount:input.sources.length,factCount:facts.length||input.audit?.accepted||null,
  sourceHashes:input.sources.map(s=>({key:s.key,hash:s.hash||hash(s.content),factRefs:s.factRefs||[]})),
  organization:facts.filter(f=>f.kind==='organization'),resources:facts.filter(f=>f.kind==='resource'),
  decisions:facts.filter(f=>f.kind==='decision'),pending:input.audit?.pending||[],capacity:input.capacity||null};
}
export function contextReceipt(payload){
 const sources=payload.context||payload.sources||payload.input?.sources||[];
 return {stage:payload.task,key:payload.key||null,payloadHash:hash(payload),sourceKeys:sources.map(s=>s.key),
  sourceRefs:[...new Set(sources.flatMap(s=>s.factRefs||[]))],characters:JSON.stringify(payload).length};
}
// Current-round neighbour commitments, not the obsolete initial sketch.
// Strip only diagnostics/display caches, never business fields or child work.
export function candidateContext(units){
 return units.map(function copy(node){
  return Object.fromEntries(Object.entries(node).filter(([key])=>!['generatedFieldSources','humanView','children'].includes(key)).map(([key,value])=>[key,['missions','tasks','activities'].includes(key)?value.map(copy):structuredClone(value)]));
 });
}
