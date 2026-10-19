import {plainCardTitle} from './reader-view.mjs';
// Display-only: attach the round audit's business findings to the card they name, so a DRI
// sees them on their own card instead of hunting through the entry page list.
export function cardIssues(units,audit){
 const byNode=new Map(),parentOf=new Map(),unmatched=[];
 const nodes=[];const walk=(n,unit,parent)=>{nodes.push({n,unit});if(parent)parentOf.set(n.id,parent.id);(n.children||[]).forEach(c=>walk(c,unit,n));};
 (units||[]).forEach(u=>walk(u,u,null));
 for(const issue of (audit?.issues||[]).filter(x=>!x.fieldPath)){
  const hit=nodes.find(({n,unit})=>(unit.key===issue.unitKey||unit.id===issue.unitKey)&&(n.title===issue.cardTitle||plainCardTitle(n)===issue.cardTitle))
   ||nodes.find(({n})=>n.level==='po'&&(n.key===issue.unitKey||n.id===issue.unitKey));
  if(!hit){unmatched.push(issue);continue;}
  if(!byNode.has(hit.n.id))byNode.set(hit.n.id,[]);
  byNode.get(hit.n.id).push(issue);
 }
 const own=id=>byNode.get(id)||[];
 // Everything on this card and below it, with the card each finding belongs to.
 const subtree=node=>{const out=[];const visit=n=>{own(n.id).forEach(issue=>out.push({issue,node:n}));(n.children||[]).forEach(visit);};if(node)visit(node);return out;};
 const byId=new Map(nodes.map(({n})=>[n.id,n]));
 // Ancestors between `top` (exclusive) and `node` (inclusive), so a deep finding reads as Mission › Task › Activity.
 const pathFrom=(top,node)=>{const out=[];for(let n=node;n&&n.id!==top.id;n=byId.get(parentOf.get(n.id)))out.unshift(n);return out;};
 return {own,subtree,unmatched,parentOf,pathFrom};
}
