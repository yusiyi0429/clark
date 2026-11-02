import {confirmationSlots} from './governance.mjs';
// A person's explicit correction of their own review may be phrased as facts,
// rather than a verbatim replacement. Target and authority still come from the real event.
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function ownerReviewCorrectionPatch(event,card,proposal){
 if(card?.kind!=='review'||!['mission','po','company'].includes(card.level)||event.answers||event.rejectsProposal)return false;
 const selected=event.context?.selection?.id||(!event.general&&event.cardId);
 if(selected!==card.id)return false;
 const text=String(event.text||'').trim();
 if(/[?？]|是否|要不要|能不能|可不可以|假设|如果|比如|例如|举例|转述|引用|仅供讨论|供参考|尚未决定|还没决定|先别|不要改|暂不|不是让|换负责人|改负责人|调整职责|责任归属/.test(text))return false;
 const request=/(?:请|帮我|麻烦)(?:你|Nexus)?\s*(?:按(?:照)?(?:我(?:补充|说|报告)的)?(?:这(?:个|些)?|上述|以上|刚才)?(?:事实|情况|实际情况|补充内容)\s*)?(?:修正|纠正|修改|更新)(?:一下|这张复盘|这份复盘|复盘|判定|结论)?[。！!\s]*$/;
 const match=text.match(request);if(!match)return false;
 // The command alone conveys no facts. Do not infer authority from a model label.
 const statement=text.slice(0,match.index).replace(/(?:我)?(?:不同意|不认可|不接受)(?:现在|当前|原来|原有|这个|这条|这份|你给的|你写的)*(?:的)?(?:判定|结论|复盘)[，,。；;\s]*/g,'').trim();
 if(statement.replace(/[\s\p{P}]/gu,'').length<8)return false;
 const before=card.versions.at(-1).content,patch=proposal.patch;
 if(patch.verdict&&patch.verdict!==before.verdict&&confirmationSlots(card).length>1)return false;
 if(Object.keys(patch).some(k=>!['verdict','verdictReason','facts','nextInputs'].includes(k)))return false;
 const oldFacts=before.facts;if(!Array.isArray(oldFacts))return false;
 const nextFacts=patch.facts||oldFacts;
 if(nextFacts.length!==oldFacts.length)return false;
 const anchor=event.context?.item??event.item,block=event.context?.block||event.block;
 for(let i=0;i<oldFacts.length;i++){
  const old=oldFacts[i],row=nextFacts[i];
  if(!row||Object.keys({...old,...row}).some(k=>!['status','evidence','gap'].includes(k)&&!same(old[k],row[k])))return false;
  if(!same(old,row)&&oldFacts.length>1&&!(block==='facts'&&anchor===i)&&!(old.item&&statement.includes(old.item)))return false;
 }
 if(patch.nextInputs){
  if(!patch.nextInputs.length){if((patch.verdict||before.verdict)!=='达成'||nextFacts.some(f=>f.status!=='达成'))return false;}
  else{const old=before.nextInputs||[];if(old.length!==patch.nextInputs.length)return false;for(let i=0;i<old.length;i++)if(Object.keys({...old[i],...patch.nextInputs[i]}).some(k=>!['type','text'].includes(k)&&!same(old[i][k],patch.nextInputs[i][k])))return false;}
 }
 return true;
}
