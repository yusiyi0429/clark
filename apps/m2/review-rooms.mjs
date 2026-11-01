const owners=node=>String(node?.owner||'').split(/[、,，\s]+/).filter(Boolean);
// Server-projected room availability is separate from the name displayed for a substitute signer.
export function reviewConversation(node,drafts,memberId,name,rooms){
 const missions=Object.entries(drafts||{}).filter(([id,n])=>id.startsWith('rv:')&&n.level==='mission').map(([id,n])=>({...n,id}));
 node=node?.id&&drafts?.[node.id]?{...node,...drafts[node.id]}:node;
 const unassigned=node?.level==='person'&&node.person==='未指派'||node?.level==='mission'&&node.ownerAssigned===false;
 const missing=node?.level==='mission'&&String(node.id||'').startsWith('rv:')&&!drafts?.[node.id];
 const selected=node?.level==='person'?missions.filter(n=>node.person==='未指派'?n.ownerAssigned===false:n.ownerAssigned!==false&&owners(n).includes(node.person)):node?.level==='mission'&&!missing?[drafts[node.id]||node]:[];
 const own=selected.some(n=>n.ownerAssigned!==false&&owners(n).includes(name));
 const personal=!unassigned&&own&&rooms?.personal===`person:${memberId}`?rooms.personal:null;
 const units=[...new Set(selected.map(n=>n.unit).filter(unit=>rooms?.units?.includes(unit)&&rooms.unitTargets?.[unit]))];
 return {unassigned,personal,units,pending:!rooms};
}
export function groupRoomAvailable(scope,rooms,stage='review',context=null){
 if(!scope||!rooms)return false;
 return String(scope).startsWith('person:')?rooms.personal===scope&&(!context||context.personal===scope):stage!=='review'||(rooms.units||[]).includes(scope)&&Boolean(rooms.unitTargets?.[scope]);
}
export function conversationDraftKey({memberId,tab,scope,stage,reviewRound}){
 return tab==='agent'?`private:${memberId}`:`group:${memberId}:${scope}:${stage}:${stage==='review'?reviewRound||'pending':''}`;
}
// A late failure belongs to its originating draft, never to the newly selected room.
export function restoreConversationDraft(cache,key,value,currentKey,onRestore,{merge=false}={}){
 const combine=old=>!old||old===value?value:old.startsWith(value+'\n\n')?old:value+'\n\n'+old;
 if(key===currentKey){if(merge)onRestore(old=>{const restored=combine(old);cache[key]=restored;return restored;});else{cache[key]=value;onRestore(value);}}else cache[key]=merge?combine(cache[key]):value;
}
