import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion,cardStatus} from './governance.mjs';
import {queueProposals} from './nexus-memory.mjs';
import {validateNexusResult} from './nexus-policy.mjs';
import {missionDraftProblem,withdrawnFor} from './mission-structure.mjs';
import {sharedProjection,memberActor} from './shared-projection.mjs';
// 新增 / 撤掉 / 恢复 Mission (陈溪南 2026-10-22): one request per card, accepted by the PO owner; the PO is not re-confirmed.
const task=(id,owner)=>({id,unit:'talent',level:'task',owner,title:'T '+id,result:'r',checks:['c'],time:'2026-11-02—2026-11-06',effort:'约 1 人日',children:[]});
const units=()=>[{id:'talent',level:'po',name:'Domain Talent & Organization',owner:'秦梦怡',title:'PO',result:'r',checks:['c'],children:[
 {id:'talent-m1',unit:'talent',level:'mission',owner:'秦梦怡',title:'评价',result:'r',checks:['c'],time:'2026-11-02—2026-11-26',children:[task('talent-m1-t1','秦梦怡')]},
 {id:'talent-m2',unit:'talent',level:'mission',owner:'秦梦怡',title:'五项组织缺口',result:'r',checks:['c'],time:'2026-11-02—2026-11-26',children:[task('talent-m2-t1','秦梦怡'),task('talent-m2-t2','秦梦怡')]}]}];
const fresh=()=>{const s=createCollaborationState(units());s.round={id:'r24',number:24,units:units(),input:{period:'2026-11'}};s.proposals=[];return s;};
const draft={title:'Harness 和 Re-arch IC 到岗',owner:'秦梦怡',tier:'P0',time:'2026-11-02—2026-11-30',result:'两人签约，至少一人到岗',checks:['**签约：**两人 11/30 前签约'],risks:['**候选人犹豫：**备选'],
 tasks:[{title:'Harness 终面与 offer',owner:'秦梦怡',time:'2026-11-02—2026-11-14',result:'offer 发出',checks:['**发出：**11/14 前'],effort:'约 2 人日'},{title:'Re-arch IC offer',owner:'秦梦怡',time:'2026-11-02—2026-11-10',result:'offer 发出',checks:['**发出：**11/10 前'],effort:'约 1 人日'}]};
const qin=memberActor('member-08'),ceo=memberActor('member-01');
const signPo=s=>{for(const [m,slot] of [['member-01','ceo'],['member-08','unitDri']])s=applyAction(s,memberActor(m),{type:'confirm',cardId:'talent',baseVersion:1,slot});return s;};
test('新增 Mission：一张卡，PO 负责人接受后挂到 PO 下、带 Task，PO 已确认不受影响',()=>{
 let s=signPo(fresh());assert.equal(cardStatus(s.cards.talent),'已确认');
 s=queueProposals(s,'talent',[{op:'add-mission',cardId:'talent',baseVersion:1,mission:draft,reason:'到岗最急',sourceIds:[]}]);
 const p=s.proposals.at(-1);assert.deepEqual(p.patch,{});
 assert.throws(()=>applyAction(s,memberActor('member-05'),{type:'acceptProposal',cardId:'talent',proposalId:p.id}),/负责人/);
 s=applyAction(s,qin,{type:'acceptProposal',cardId:'talent',proposalId:p.id});
 assert.equal(s.proposals.at(-1).status,'accepted');
 assert.deepEqual(s.round.units[0].children.map(m=>m.id),['talent-m1','talent-m2','talent-m3']);
 assert.equal(s.cards['talent-m3'].parentId,'talent');assert.equal(s.cards['talent-m3-t2'].parentId,'talent-m3');
 assert.equal(cardStatus(s.cards['talent-m3']),'待确认');assert.equal(cardStatus(s.cards.talent),'已确认');assert.equal(currentVersion(s.cards.talent).number,1);
 const notice=s.messages.at(-1);assert.equal(notice.kind,'notice');assert.match(notice.text,/新增 Mission 3「Harness 和 Re-arch IC 到岗」（2 个 Task，约 3 人日）/);
 // From here it is an ordinary Mission: the unit DRI and the Mission DRI confirm it.
 s=applyAction(s,qin,{type:'confirm',cardId:'talent-m3',baseVersion:1,slot:'unitDri'});assert.equal(cardStatus(s.cards['talent-m3']),'待另一方确认');
 const view=sharedProjection(s,ceo);assert.ok(view.drafts['talent-m3-t1']);assert.ok(view.round.units[0].children.some(m=>m.id==='talent-m3'));
});
test('撤掉 Mission：连同 Task 离开计划和页面，数据保留；@Nexus 恢复后原样回来',()=>{
 let s=queueProposals(fresh(),'talent',[{op:'withdraw-mission',cardId:'talent',baseVersion:1,missionId:'talent-m2',reason:'放到 12 月',sourceIds:[]}]);
 s=applyAction(s,qin,{type:'acceptProposal',cardId:'talent',proposalId:s.proposals.at(-1).id});
 assert.deepEqual(s.round.units[0].children.map(m=>m.id),['talent-m1']);assert.equal(s.cards['talent-m2'],undefined);assert.equal(s.cards['talent-m2-t1'],undefined);
 assert.equal(sharedProjection(s,ceo).drafts['talent-m2'],undefined);
 assert.match(s.messages.at(-1).text,/撤掉了「五项组织缺口」（下面 2 个 Task，约 2 人日）。需要恢复时在群里 @Nexus/);
 assert.deepEqual(withdrawnFor(s,'talent').map(w=>w.id),['talent-m2']);
 // A new Mission never takes a withdrawn one's number.
 s=queueProposals(s,'talent',[{op:'add-mission',cardId:'talent',baseVersion:1,mission:draft,reason:'r',sourceIds:[]}]);s=applyAction(s,qin,{type:'acceptProposal',cardId:'talent',proposalId:s.proposals.at(-1).id});
 assert.ok(s.cards['talent-m3']);
 s=queueProposals(s,'talent',[{op:'restore-mission',cardId:'talent',baseVersion:1,missionId:'talent-m2',reason:'r',sourceIds:[]}]);s=applyAction(s,qin,{type:'acceptProposal',cardId:'talent',proposalId:s.proposals.at(-1).id});
 assert.deepEqual(s.round.units[0].children.map(m=>m.id),['talent-m1','talent-m2','talent-m3']);assert.ok(s.cards['talent-m2-t2']);assert.deepEqual(withdrawnFor(s,'talent'),[]);
});
test('同一请求只出一张卡；PO 改版后新增卡仍然有效',()=>{
 let s=fresh();const card={op:'withdraw-mission',cardId:'talent',baseVersion:1,missionId:'talent-m2',reason:'r',sourceIds:[]};
 s=queueProposals(queueProposals(s,'talent',[card]),'talent',[card]);assert.equal(s.proposals.filter(p=>p.op).length,1);
 s=applyAction(s,qin,{type:'revise',cardId:'talent',baseVersion:1,patch:{result:'新的结果'}});
 assert.equal(sharedProjection(s,ceo).records['group:talent'].find(r=>r.op).stale,false);
 s=applyAction(s,qin,{type:'acceptProposal',cardId:'talent',proposalId:s.proposals.find(p=>p.op).id});assert.equal(s.cards['talent-m2'],undefined);
});
test('Nexus 的 Mission 卡：要有明确的增删要求，撤掉的 Mission 必须在这个 PO 下，恢复的必须是撤掉过的',()=>{
 const cards=[{id:'talent',level:'po',version:1,owner:'秦梦怡',title:'PO'},{id:'talent-m2',level:'mission',version:1,owner:'秦梦怡',title:'五项组织缺口'},{id:'bf01-m1',level:'mission',version:1}];
 const ask={id:'e1',author:'秦梦怡',text:'@Nexus 帮我加一条 P0 Mission：两人到岗，把五项组织缺口撤掉',createdAt:'2026-10-22T03:00:00Z',context:{scope:'talent'}};
 const chat={id:'e2',author:'刘明华',text:'到岗挺关键的',createdAt:'2026-10-22T03:00:00Z',context:{scope:'talent'}};
 const run=(missionCards,evidence=[ask])=>validateNexusResult({reply:'',topics:[],proposals:[],missionCards},{cards,evidence,fresh:evidence,manual:true,withdrawn:[{id:'talent-m4'}]});
 const out=run([{op:'add-mission',poId:'talent',brief:'Harness 和 Re-arch IC 到岗，P0，秦梦怡',sourceIds:['e1']},{op:'withdraw-mission',poId:'talent',missionId:'talent-m2',sourceIds:['e1']}]);
 assert.deepEqual(out.missionCards.map(m=>m.op),['add-mission','withdraw-mission']);assert.equal(out.reply,'');
 assert.equal(run([{op:'add-mission',poId:'talent',brief:'x',sourceIds:['e2']}],[chat]).missionCards.length,0);
 assert.equal(run([{op:'withdraw-mission',poId:'talent',missionId:'bf01-m1',sourceIds:['e1']}]).missionCards.length,0);
 assert.equal(run([{op:'restore-mission',poId:'talent',missionId:'talent-m9',sourceIds:['e1']}]).missionCards.length,0);
 assert.equal(run([{op:'restore-mission',poId:'talent',missionId:'talent-m4',sourceIds:['e1']}]).missionCards.length,1);
});
test('技能起草的 Mission 缺东西就不出卡',()=>{
 assert.equal(missionDraftProblem(draft),null);
 assert.match(missionDraftProblem({...draft,checks:[]}),/验收/);assert.match(missionDraftProblem({...draft,tasks:[]}),/Task/);assert.match(missionDraftProblem({...draft,time:'11 月'}),/时间/);
});
