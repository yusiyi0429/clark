// A confirmed Mission contributes exactly one status in its PO's facts. No model decides delivery or permission.
import {queueProposals} from './nexus-memory.mjs';
const v=c=>c?.versions?.at(-1),eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ref=x=>String(x||'').replace(/^rv:/,'');
export function missionFactIndex(parent,child){const rows=v(parent)?.content.facts||[],ids=new Set([ref(child.id),ref(child.ref),ref(v(child)?.content.ref)].filter(Boolean)),found=rows.flatMap((f,i)=>ids.has(ref(f.ref))?[i]:[]);return found.length===1?found[0]:-1;}
export function confirmedMissionSourceProblem(state,p,patch=p.patch){
 const mark=p.confirmedMission;if(!mark)return null;
 const child=state.cards[p.fromMission?.id],parent=state.cards[p.cardId],cv=v(child),pv=v(parent);
 if(!parent||!child||child.kind!=='review'||child.level!=='mission'||child.parentId!==parent?.id||parent.kind!=='review'||parent.level!=='po')return '确认来源与单元复盘不对应';
 if(mark.round!==(state.reviewRound?.loadedAt||null)||cv.number!==p.fromMission.version||child.confirmedVersion!==cv.number)return '个人复盘已有新草稿或确认版本已变化';
 const index=missionFactIndex(parent,child);if(index<0||ref(mark.ref)!==ref(pv.content.facts[index].ref))return '单元复盘没有唯一对应的 Mission 行';
 const wanted=pv.content.facts.map((f,i)=>i===index?{...f,status:cv.content.verdict}:f);
 if(!patch||Object.keys(patch).length!==1||!eq(patch.facts,wanted))return '这里只能同步已确认 Mission 对应行的状态';
 return null;
}
export function syncConfirmedMissionStatus(state,child,now){
 const parent=state.cards[child.parentId],cv=v(child);if(child.kind!=='review'||child.level!=='mission'||child.confirmedVersion!==cv.number||parent?.kind!=='review'||parent.level!=='po')return;
 const index=missionFactIndex(parent,child);if(index<0){state.reviewStatusLog=[...(state.reviewStatusLog||[]),{childId:child.id,version:cv.number,reason:'单元复盘没有唯一对应的 Mission 行',at:now}].slice(-50);return;}
 const row=v(parent).content.facts[index];
 // Later drafts invalidate a source; accepted history remains immutable.
 for(const p of state.proposals||[])if(p.status==='pending'&&p.confirmedMission&&p.fromMission?.id===child.id&&p.fromMission.version!==cv.number){p.status='superseded';p.supersededBy=`个人复盘确认 v${cv.number}`;p.supersededAt=now;}
 if(row.status===cv.content.verdict)return;
 const proposal={cardId:parent.id,baseVersion:v(parent).number,patch:{facts:v(parent).content.facts.map((f,i)=>i===index?{...f,status:cv.content.verdict}:f)},reason:`「${cv.content.title||child.title}」已确认 v${cv.number}，将对应行状态从「${row.status}」改为「${cv.content.verdict}」。`,sourceIds:[],basis:'cascade',requiresConfirmation:true,fromMission:{id:child.id,version:cv.number},confirmedMission:{ref:row.ref,round:state.reviewRound?.loadedAt||null},originSequence:state.sequence+1};
 queueProposals(state,parent.unit||parent.id,[proposal]);
}
// Only a value the PO actually quotes can trigger a draft fact recheck. A changed Task status alone does not.
export function quotedReviewFields(parent,child,before,after){
 const index=missionFactIndex(parent,child);if(index<0)return [];
 const row=v(parent).content.facts[index],text=JSON.stringify({evidence:row.evidence,gap:row.gap,nextInputs:v(parent).content.nextInputs,verdictReason:v(parent).content.verdictReason});
 const values=c=>[c.verdictReason,...(c.facts||[]).flatMap(f=>[f.evidence,f.gap]),...(c.nextInputs||[]).map(n=>n.text)].filter(x=>typeof x==='string'&&x.trim().length>=8);
 const newer=values(after);return values(before).some(x=>!newer.includes(x)&&text.includes(x))?['facts','verdictReason','nextInputs'].filter(k=>!eq(before[k],after[k])):[];
}
