// Split independent fields/identified rows; all values remain full source patches, never model reinterpreted.
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const key=x=>x?.ref||x?.id;
function rowChanges(before,after){
 if(!Array.isArray(before)||!Array.isArray(after)||[before,after].some(a=>a.some(x=>!key(x))||new Set(a.map(key)).size!==a.length))return null;
 if(before.length!==after.length||before.some((x,i)=>key(x)!==key(after[i])))return null;
 return after.filter((x,i)=>!eq(x,before[i]));
}
export function patchPaths(before,patch){return Object.entries(patch).flatMap(([f,v])=>{const rows=['facts','nextInputs'].includes(f)?rowChanges(before?.[f],v):null;return rows?rows.map(x=>f+'/'+key(x)):[f];});}
export const pathsOverlap=(a,b)=>a.some(x=>b.some(y=>x===y||x.startsWith(y+'/')||y.startsWith(x+'/')));
export function splitProposal(proposal,content){
 if(proposal.op)return [proposal];const patch=proposal.patch||{};
 const one=p=>({...p,requiresConfirmation:true});
 // A verdict and its supporting facts/next input form one decision; never split their invariants.
 if('verdict'in patch)return [one(proposal)];
 const fields=Object.keys(patch);
 if(fields.length!==1)return [one(proposal)];
 const f=fields[0],value=patch[f],rows=['facts','nextInputs'].includes(f)?rowChanges(content[f],value):null;
 if(!rows||rows.length<2)return [one(proposal)];
 return rows.map(row=>one({...proposal,patch:{[f]:content[f].map(x=>key(x)===key(row)?row:x)}}));
}

export function rebasePatch(before,patch,current){
 return Object.fromEntries(Object.entries(patch).map(([f,value])=>{const rows=['facts','nextInputs'].includes(f)?rowChanges(before?.[f],value):null;if(!rows)return [f,value];const changed=new Map(rows.map(x=>[key(x),x]));return [f,current[f].map(x=>changed.get(key(x))||x)];}));
}
