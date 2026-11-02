import {appendFile} from 'node:fs/promises';
import {memberProfiles} from './member-profiles.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';

const debugMembers=new Set(['member-01','member-04','member-08']);
export const mayDebugReviews=id=>debugMembers.has(id);
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
// This is a separate read surface, never an impersonated session. Normal routes
// continue to authenticate and execute as the real signed-in member.
export async function readDebugReviews({session,targetId,state,method='GET'},audit){
 if(!mayDebugReviews(session?.memberId))fail(403,'当前账号不能使用只读调试');
 if(method!=='GET')fail(405,'调试视图只支持查看');
 if(!Object.hasOwn(memberProfiles,targetId||''))fail(400,'请选择名单中的用户');
 const view=sharedProjection(state,memberActor(targetId,state));
 const cards=Object.entries(view.drafts).filter(([id])=>state.cards[id]?.kind==='review').map(([id,n])=>{
  // Hidden insights belong to the author, not to the debugger. Do not send
  // another user's unpublished insights or history via a nested object.
  const {insights,history,...card}=n;return {...card,id};
 });
 const publicScopes=new Set(view.reviewRooms.units);
 const groups=Object.entries(view.records).filter(([key])=>key.startsWith('group:')&&publicScopes.has(key.slice(6))).map(([key,rows])=>({
  scope:key.slice(6),messages:rows.map(row=>({id:row.id,author:row.author,kind:row.kind,text:row.text||'',createdAt:row.createdAt,status:row.status,
   ...(row.kind==='revision-proposal'?{cardId:row.cardId,patch:row.patch}:{}),
  })),
 }));
 const result={actorId:session.memberId,targetId,readOnly:true,period:view.review?.period||null,cards,groups};
 try{await audit({at:new Date().toISOString(),actorId:session.memberId,targetId,action:'read-review-debug',cardCount:cards.length,groupCount:groups.length});}
 catch{fail(503,'调试访问记录暂时无法保存，请稍后再试');}
 return result;
}
export const debugReviewAudit=path=>entry=>appendFile(path,JSON.stringify(entry)+'\n',{mode:0o600});
