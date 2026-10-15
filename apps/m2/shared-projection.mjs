import {visibleReaderViews} from './deployment-projection.mjs';
import {memberProfiles} from './member-profiles.mjs';
import {ownerName} from './owner-name.mjs';
export {ownerName};
import {canRead,currentVersion,cardStatus,mayRevise} from './governance.mjs';
import {reviewChanges} from './review-workflow.mjs';
import {materializeTopics} from './topic-lifecycle.mjs';
export function memberActor(id,state){const p=memberProfiles[id];if(!p)throw Object.assign(Error('请选择名单中的试用成员'),{status:400});const missions=state?.round?Object.values(state.cards).filter(c=>c.level==='mission'&&ownerName(currentVersion(c).content.owner)===p.name).map(c=>c.id):p.missions;return {id,name:p.name,ceo:p.ceo,visibleUnits:[...new Set([...(p.units||[]),...missions.map(id=>state?.cards[id]?.unit).filter(Boolean)])],unitDri:p.unitDri,missionDri:missions};}
export function sharedProjection(state,actor){
 const cards=Object.values(state.cards).filter(c=>canRead(actor,c));
 const drafts=Object.fromEntries(cards.map(c=>[c.id,{...currentVersion(c).content,status:cardStatus(c),signatures:currentVersion(c).signatures,upstreamChange:c.upstreamChange,history:c.versions.slice(1).map((v,i)=>({from:c.versions[i].number,to:v.number,author:memberProfiles[v.author]?.name||v.author,changes:reviewChanges(c.versions[i].content,v.content)}))}]));
 const comments={},records={};
 const show=e=>({...e,author:memberProfiles[e.author]?.name||e.author,...(e.replyPreview?{replyPreview:{...e.replyPreview,author:memberProfiles[e.replyPreview.author]?.name||e.replyPreview.author}}:{}),context:e.context||{scope:e.scope,selection:e.cardId?{id:e.cardId,version:e.version}:null,block:e.block}});
 for(const e of state.comments.filter(e=>drafts[e.cardId])){(comments[e.cardId]??=[]).push(show(e));(records['group:'+e.scope]??=[]).push({...show(e),kind:'comment'});}
 for(const e of state.messages){if(e.channel==='private'?e.memberId!==actor.id:!actor.ceo&&!actor.visibleUnits.includes(e.scope))continue;(records[e.channel==='private'?'private:'+actor.id:'group:'+e.scope]??=[]).push(show(e));}
 for(const p of state.proposals||[]){if(!drafts[p.cardId])continue;const c=state.cards[p.cardId],reviewer=c.level==='po'?c:c.level==='mission'?c:state.cards[c.id.split('-t')[0]];(records['group:'+p.scope]??=[]).push({...p,kind:'revision-proposal',author:'Nexus',text:p.reason,canAccept:mayRevise(actor,c),reviewerName:reviewer?currentVersion(reviewer).content.owner:'成果负责人',stale:p.baseVersion!==currentVersion(c).number,status:p.status,sources:[...state.comments,...state.messages].filter(e=>p.sourceIds.includes(e.id)&&e.channel==='group'&&e.scope===p.scope).map(show)});}
 for(const rows of Object.values(records))rows.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 const scopes=new Set([...Object.keys(state.nexus||{}),...Object.keys(records).filter(k=>k.startsWith('group:')).map(k=>k.slice(6))]);
 const nexus=Object.fromEntries([...scopes].filter(id=>drafts[id]).map(id=>[id,{...state.nexus?.[id],topics:materializeTopics(state.nexus?.[id]?.topics,(records['group:'+id]||[]).filter(r=>r.kind!=='revision-proposal'))}]));
 return {memberId:actor.id,sequence:state.sequence,drafts,comments,records,nexus,pausedUnits:state.pausedUnits||[],round:state.round?{id:state.round.id,number:state.round.number,units:state.round.units.filter(u=>canRead(actor,state.cards[u.id])),readerViews:visibleReaderViews(state.round.readerViews||state.round.input?.readerViews,state,actor),sourceTime:state.round.input.retrievedAt}:null,missions:actor.missionDri,visibleUnits:actor.ceo?null:actor.visibleUnits};
}
