export function isRevisionConfirmation(text){return /^(?:确认(?:修改|修订)?|同意(?:修改|修订)?|好的?|可以|ok|okay|就这样改|按这个改)[。！!\s]*$/iu.test(String(text||'').trim());}
export function confirmationProposal(state,entry){
 if(!isRevisionConfirmation(entry.text))return null;
 const proposals=(state.proposals||[]).filter(p=>p.scope===entry.scope);
 if(entry.replyTo)return proposals.find(p=>p.id===entry.replyTo&&p.status==='pending')||null;
 const pending=proposals.filter(p=>p.status==='pending'&&(entry.cardId===entry.scope||p.cardId===entry.cardId));
 if(pending.length!==1)return null;
 const proposal=pending[0];
 // Bare OK is accepted only immediately after a single, visible proposed change.
 const last=[...state.comments,...state.messages,...proposals].filter(e=>e.scope===entry.scope&&e.id!==entry.id).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||(a.createdSequence||0)-(b.createdSequence||0)).at(-1);
 return last?.id===proposal.id?proposal:null;
}
