import {test} from 'node:test';
import assert from 'node:assert/strict';
import {directQuestion,participationDecision} from './nexus-participation.mjs';
import {validateNexusResult,publicEvidence} from './nexus-policy.mjs';
import {createCollaborationState,applyAction} from './governance.mjs';
import {queueProposals,rememberedEvidence} from './nexus-memory.mjs';
const cards=[{id:'bf01',title:'客户试用',version:1}];
test('批量新消息超过30条仍保留待处理证据和引用父消息',()=>{
 const rows=Array.from({length:80},(_,i)=>({id:String(i)}));rows[40].replyTo='1';
 const selected=rememberedEvidence(rows,[],['0','40']);assert.ok(selected.some(r=>r.id==='0'));assert.ok(selected.some(r=>r.id==='1'));
});
test('只有新呼叫触发回应；冷却不阻断明确提问',()=>{
 const historical={id:'old',author:'甲',text:'@Nexus 请核对'};
 assert.equal(validateNexusResult({topics:[],proposals:[],reply:'收到'},{cards,evidence:[historical],fresh:[{id:'new',text:'好的'}]}).reply,'');
 for(const e of [{text:'@Nexus 请回答'},{text:'Nexus，你怎么看'},{text:'能解释一下吗',replyToAuthor:'Nexus'}])assert.equal(directQuestion(e),true);
 assert.equal(directQuestion({text:'我认为可以'}),false);
 assert.equal(participationDecision({},{fresh:[historical],lastIntervention:{at:new Date().toISOString()}}).speak,true);
});
test('主动发言需新证据，重复风险冷却，普通讨论静默',()=>{
 const fresh=[{id:'a',text:'时间有变化'}],value={interventionNeeded:true,interventionType:'risk',interventionReason:'日期冲突',interventionSourceIds:['a'],interventionKey:'window'};
 assert.equal(participationDecision(value,{fresh}).speak,true);
 assert.equal(participationDecision({...value,interventionSourceIds:['old']},{fresh}).speak,false);
 assert.equal(participationDecision(value,{fresh,lastIntervention:{key:'other',at:new Date().toISOString()}}).speak,false);
});
test('修订卡片不重复播报；明确呼叫仍正常回答',()=>{
 const evidence=[{id:'a',author:'甲',kind:'document-comment',text:'请修改名称',context:{selection:{id:'bf01',version:1},block:'title'}}];
 const value={topics:[],proposals:[{cardId:'bf01',baseVersion:1,basis:'request',sourceIds:['a'],patch:{title:'明确客户试用'}}],reply:'已整理修订',interventionNeeded:true,interventionType:'risk',interventionReason:'名称不清',interventionSourceIds:['a']};
 assert.equal(validateNexusResult(value,{cards,evidence}).reply,'');assert.equal(validateNexusResult(value,{cards,evidence,manual:true}).reply,'已整理修订');
});
test('回复消息建立群聊议题，反对立即重开，跨领域引用拒绝',()=>{
 const actor={id:'甲',ceo:true};let s=createCollaborationState([{id:'bf01',level:'po',title:'客户试用',children:[]},{id:'eo',level:'po',title:'其他',children:[]}]);
 s=applyAction(s,actor,{type:'message',cardId:'bf01',text:'客户试用先做一轮'});const first=s.messages[0];
 s=applyAction(s,{id:'乙',ceo:true},{type:'message',cardId:'bf01',text:'同意先做一轮',replyTo:first.id});
 const evidence=publicEvidence(s.messages,'bf01');
 const topic={title:'试用轮次',status:'agreement',conclusion:'先做一轮',sourceIds:evidence.map(e=>e.id),quotes:evidence.map(e=>({id:e.id,text:e.text}))};
 const result=validateNexusResult({topics:[topic],proposals:[]},{cards,evidence});assert.equal(result.topics[0].status,'agreement');
 s.nexus={bf01:{topics:result.topics}};s=applyAction(s,{id:'丙',ceo:true},{type:'message',cardId:'bf01',text:'不同意，需要核对',replyTo:first.id});assert.equal(s.nexus.bf01.topics[0].status,'discussing');
 assert.equal(validateNexusResult({topics:[topic],proposals:[]},{cards,evidence:publicEvidence(s.messages,'bf01')}).topics[0].status,'discussing');
 assert.throws(()=>applyAction(s,actor,{type:'message',cardId:'eo',text:'同意',replyTo:first.id}),/引用消息/);
});
test('已拒绝建议无新证据不再出现，提出后反对阻止接受',()=>{
 const actor={id:'甲',ceo:true,unitDri:['bf01']};let s=createCollaborationState([{id:'bf01',level:'po',title:'客户试用',children:[]}]);
 s=applyAction(s,actor,{type:'comment',cardId:'bf01',block:'title',text:'请修改名称'});const p={cardId:'bf01',baseVersion:1,sourceIds:[s.comments[0].id],patch:{title:'新标题'}};queueProposals(s,'bf01',[p]);
 const id=s.proposals[0].id;s=applyAction(s,actor,{type:'rejectProposal',cardId:'bf01',proposalId:id});queueProposals(s,'bf01',[p]);assert.equal(s.proposals.length,1);
 s=applyAction(s,actor,{type:'comment',cardId:'bf01',block:'title',text:'把标题改为新标题'});queueProposals(s,'bf01',[{...p,sourceIds:[s.comments.at(-1).id]}]);assert.equal(s.proposals.length,2);
 s=applyAction(s,actor,{type:'comment',cardId:'bf01',block:'title',text:'不同意这个修改'});assert.throws(()=>applyAction(s,actor,{type:'acceptProposal',cardId:'bf01',proposalId:s.proposals[1].id}),/新分歧/);
});
