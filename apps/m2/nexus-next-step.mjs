import {createHash} from 'node:crypto';
import {disagrees} from './stance.mjs';
const bare=s=>s.replace(/[。．.；;，,！!？?\s]+$/,'');
const short=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max?v.trim():'';
// Waiting conditions must be quoted from public evidence, not invented deadlines.
export function verifiedWaiting(value,{card,sources,sourceIds,refersTo}){
 if(!value||!card||value.cardId!==card.id||value.baseVersion!==card.version)return null;
 const rows=sourceIds.map(id=>sources.get(id)).filter(Boolean);
 if(!rows.length||rows.some(r=>!refersTo(r,card)))return null;
 if(rows.some(r=>r.context?.selection?.id===card.id&&r.context.selection.version!==card.version))return null;
 const recipient=short(value.recipient,40),missing=short(value.missing,100),recheckWhen=short(value.recheckWhen,100);
 if(!recipient||!missing||!recheckWhen)return null;
 const supported=rows.some(r=>(r.author===recipient||r.text.includes(recipient))&&r.text.includes(missing)&&r.text.includes(recheckWhen));
 return supported?{cardId:card.id,baseVersion:card.version,recipient,missing,recheckWhen}:null;
}
export function verifiedIntervention(value,{cards,evidence,refersTo}){
 const card=cards.find(c=>c.id===value.interventionCardId);
 const ids=value.interventionSourceIds;
 if(!card||value.interventionVersion!==card.version||!Array.isArray(ids)||!ids.length)return null;
 const rows=ids.map(id=>evidence.find(e=>e.id===id));
 if(rows.some(r=>!r||!refersTo(r,card)||r.context?.selection?.id===card.id&&r.context.selection.version!==card.version))return null;
 // Mediation needs two people with a real conflict; its two-sided summary may be a little longer.
 const mediation=value.interventionType==='mediation';
 if(mediation&&(new Set(rows.map(r=>r.author)).size<2||!rows.some(r=>disagrees(r.text))))return null;
 const recipient=short(value.interventionRecipient,40),impact=short(value.interventionImpact,mediation?120:70),question=short(value.interventionQuestion,mediation?90:70),key=short(value.interventionKey,100);
 if(!recipient||!impact||!question||!key||!(card.owner===recipient||rows.some(r=>r.author===recipient||r.text.includes(recipient))))return null;
 // The issue key is scoped to a current result version. Repeated message IDs do not create new facts.
 const facts=[...new Set(rows.map(r=>JSON.stringify({text:r.text,selection:r.context?.selection,block:r.context?.block})))].sort();
 const signature=createHash('sha256').update(JSON.stringify([card.id,card.version,facts])).digest('hex');
 const reply=mediation?`${recipient}，“${card.title}”上有两种意见：${bare(impact)}。${bare(question)}。`:`${recipient}，“${card.title}”：${bare(impact)}。请回答：${bare(question)}`;
 if(reply.length>(mediation?240:180))return null;
 return {signature,reply};
}
