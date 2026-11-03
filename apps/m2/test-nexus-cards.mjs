import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateNexusResult,reconcileReply,cardName,cardAliases} from './nexus-policy.mjs';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {recordTopic} from './topic-lifecycle.mjs';
// 2026-10-19 drill: cards the model proposed were dropped silently while the reply said they were out.
const cards=[{id:'talent',level:'po',version:1,title:'人才 PO',owner:'刘人豪',result:'r'},{id:'talent-m02',level:'mission',version:1,title:'招聘渠道',owner:'于斯一',tier:'P1',result:'r'},{id:'talent-m03',level:'mission',version:1,title:'面试流程',owner:'王创峰',tier:'P2',result:'r'},{id:'talent-m04',level:'mission',version:1,title:'入职',owner:'秦梦怡',result:'r'},{id:'talent-m05',level:'mission',version:1,title:'培训',owner:'唐巨杰',result:'r'}].map(c=>({...c,aliases:cardAliases(c.id)}));
const po={id:'c1',channel:'group',kind:'document-comment',author:'刘明华',text:'请把成果改成本月招满 5 人，下面的 Mission 跟着改',context:{selection:{id:'talent',version:1},block:'result'}};
const run=(proposals,evidence=[po])=>validateNexusResult({topics:[],proposals},{cards,evidence,fresh:evidence});
test('上级多项批注可保留超过4张独立修订卡',()=>{
 const r=run([{cardId:'talent-m02',baseVersion:1,basis:'request',sourceIds:['c1'],patch:{result:'渠道支撑招满 5 人'}},{cardId:'talent',baseVersion:1,basis:'request',sourceIds:['c1'],patch:{result:'本月招满 5 人'}},{cardId:'talent-m03',baseVersion:1,basis:'request',sourceIds:['c1'],patch:{result:'面试流程支撑 5 人'}},{cardId:'talent-m04',baseVersion:1,basis:'request',sourceIds:['c1'],patch:{result:'入职 5 人'}},{cardId:'talent-m05',baseVersion:1,basis:'request',sourceIds:['c1'],patch:{result:'培训 5 人'}}]);
 assert.deepEqual(r.proposals.map(p=>p.cardId).sort(),['talent','talent-m02','talent-m03','talent-m04','talent-m05']);
});
test('Mission 档位可以出卡，只能 P0/P1/P2，PO 不设档位；被拦都写明原因',()=>{
 const ask={...po,id:'c2',text:'请把 M03 改成 P0',context:{selection:{id:'talent-m03',version:1},block:'result'}};
 let r=run([{cardId:'talent-m03',baseVersion:1,basis:'request',sourceIds:['c2'],patch:{tier:'P0'}}],[ask]);
 assert.equal(r.proposals.length,1);
 r=run([{cardId:'talent-m03',baseVersion:1,basis:'request',sourceIds:['c2'],patch:{tier:'P3'}},{cardId:'talent',baseVersion:1,basis:'request',sourceIds:['c1'],patch:{tier:'P0'}}],[po,ask]);
 assert.equal(r.proposals.length,0);
 assert.ok(r.rejected.every(x=>x.why.includes('档位')),JSON.stringify(r.rejected));
 r=run([{cardId:'talent-m02',baseVersion:2,basis:'request',sourceIds:['c1'],patch:{result:'x'}}]);
 assert.deepEqual(r.rejected,[{cardId:'talent-m02',why:'卡已更新到新版本'}]);
});
test('别的 Mission 上的批注不能拿来改这张',()=>{
 const other={...po,id:'c3',context:{selection:{id:'talent-m02',version:1},block:'result'}};
 const r=run([{cardId:'talent-m03',baseVersion:1,basis:'request',sourceIds:['c3'],patch:{result:'x'}}],[other]);
 assert.equal(r.proposals.length,0);assert.equal(r.rejected[0].why,'依据挂在别的卡上');
});
test('回复只说真正出了的卡',()=>{
 assert.equal(cardName('talent-m02-t01'),'M02 的 T01');
 assert.match(reconcileReply('M02、M03 修订卡已出，请确认。',[{cardId:'talent-m02'}],[{cardId:'talent-m03',why:'依据里没提到这张卡'}]),/更正：M03（依据里没提到这张卡） 没出成卡/);
 assert.equal(reconcileReply('已出修订卡，请确认。',[],[{cardId:'talent-m03',why:'这张卡上还有人反对'}]),'这次没出成修订卡：M03（这张卡上还有人反对）。');
 assert.equal(reconcileReply('好的，周五前给数。',[],[]),'好的，周五前给数。');
});
test('负责人可以改 Mission 档位，但只能 P0/P1/P2',()=>{
 const mission={id:'bf01-m1',unit:'bf01',level:'mission',title:'Mission',version:1,tier:'P1',children:[]};
 const s=createCollaborationState([{id:'bf01',level:'po',title:'PO',version:1,children:[mission]}]),owner={id:'owner',visibleUnits:['bf01'],missionDri:['bf01-m1']},dri={id:'dri',visibleUnits:['bf01'],unitDri:['bf01']};
 const next=applyAction(s,owner,{type:'revise',cardId:'bf01-m1',baseVersion:1,patch:{tier:'P0'}});
 assert.equal(currentVersion(next.cards['bf01-m1']).content.tier,'P0');
 assert.throws(()=>applyAction(s,owner,{type:'revise',cardId:'bf01-m1',baseVersion:1,patch:{tier:'P5'}}),/档位/);
 assert.throws(()=>applyAction(s,dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{tier:'P0'}}),/档位/);
});
test('刚达成一致后接着说的话并进那个话题，单句“接受了”不重开',()=>{
 const at=m=>new Date(Date.UTC(2026,9,19,8,m)).toISOString();
 const topics=[{id:'old',anchor:{threadId:'q0'},title:'旧问题',status:'discussing',sourceIds:['q0'],quotes:[],updatedAt:at(0)},{id:'done',anchor:{threadId:'q1'},title:'PO 招满 5 人',status:'agreement',conclusion:'按 5 人改',sourceIds:['q1'],quotes:[],updatedAt:at(10)}];
 recordTopic(topics,{id:'m1',channel:'group',author:'刘明华',text:'PO这张我接受了。',createdAt:at(12)});
 assert.equal(topics.length,2);assert.equal(topics[1].status,'agreement');assert.ok(topics[1].sourceIds.includes('m1'));
 recordTopic(topics,{id:'m2',channel:'group',author:'刘明华',text:'M02 也按 5 人口径改一下',createdAt:at(13)});
 assert.equal(topics.length,2);assert.ok(topics[1].sourceIds.includes('m2'));assert.equal(topics[1].status,'discussing');
 recordTopic(topics,{id:'m3',channel:'group',author:'于斯一',text:'渠道这边周五给名单',createdAt:at(80)});
 assert.ok(topics[1].sourceIds.includes('m3'),'超过半小时仍接最新的未定话题');
});
test('一句话点了 M02 和 M03、“按这个改”这类口头请求，都能出卡',()=>{
 const line={id:'g1',channel:'group',author:'秦梦怡',text:'PO这张我接受了。不过下面M02招人还是P1、M03股权还写着10/30，@Nexus 这两条也帮我按刚才说的改一下，M02提到P0'};
 const r=run([{cardId:'talent-m02',baseVersion:1,basis:'request',sourceIds:['g1'],patch:{tier:'P0'}},{cardId:'talent-m03',baseVersion:1,basis:'agreement',sourceIds:['g1'],patch:{time:'11月'}}],[line]);
 assert.deepEqual(r.proposals.map(p=>p.cardId),['talent-m02','talent-m03'],JSON.stringify(r.rejected));
 const said={id:'g2',channel:'group',author:'孙铭泽',text:'我来改M02验收：第二周还会主动再用一次。'},ask={id:'g3',channel:'group',author:'刘明华',text:'@Nexus 按这个改',replyTo:'g2'};
 assert.equal(run([{cardId:'talent-m02',baseVersion:1,basis:'request',sourceIds:['g3'],patch:{result:'第二周再用一次'}}],[said,ask]).proposals.length,1);
});
test('征求意见时提到“再出卡”不算声称已出卡，原话保留',()=>{
 const ask='加班 1.5 人天风险大，建议逐笔结算推到 11 月初。你同意的话我就出修订卡。';
 assert.equal(reconcileReply(ask,[],[]),ask);
 assert.match(reconcileReply('M02 修订卡已出，请确认。',[],[]),/没能生成可确认的修订卡/);
});
test('拒绝修订卡要写理由：理由作为负责人的回复进群，Nexus 按理由重出一版',async()=>{
 const {queueProposals}=await import('./nexus-memory.mjs');
 const mission={id:'bf01-m1',unit:'bf01',level:'mission',title:'Mission',version:1,result:'旧',children:[]};
 let s=createCollaborationState([{id:'bf01',level:'po',title:'PO',version:1,children:[mission]}]);
 s.messages.push({id:'src',channel:'group',scope:'bf01',author:'ceo',text:'请改成果',createdAt:new Date().toISOString()});
 s=queueProposals(s,'bf01',[{cardId:'bf01-m1',baseVersion:1,sourceIds:['src'],reason:'r',patch:{result:'新'}}]);
 const owner={id:'owner',visibleUnits:['bf01'],missionDri:['bf01-m1']},p=s.proposals[0];
 s=applyAction(s,owner,{type:'rejectProposal',cardId:'bf01-m1',proposalId:p.id,reason:'22号来不及，最多24号'});
 assert.equal(s.proposals[0].status,'rejected');assert.equal(s.proposals[0].rejectReason,'22号来不及，最多24号');
 const line=s.messages.at(-1);assert.equal(line.rejectsProposal,p.id);assert.equal(line.replyTo,p.id);assert.match(line.text,/不采用这张修订卡：22号来不及/);
 const ev={id:line.id,author:'孙铭泽',text:line.text,kind:'chat',rejectsProposal:p.id,replyTo:p.id,context:{selection:{id:'talent-m03',version:1},block:'card'}};
 const r=run([{cardId:'talent-m03',baseVersion:1,basis:'agreement',sourceIds:[line.id],patch:{time:'10/24'}}],[ev]);
 assert.equal(r.proposals.length,1,JSON.stringify(r.rejected));
});
test('误拒后上级说“再出一遍卡”，算明确要求；没出成时回复不自相矛盾',()=>{
 const ask={id:'g9',channel:'group',author:'刘明华',text:'@Nexus M02 和 M03 秦梦怡手滑拒了，按原来的再出一遍卡给她'};
 assert.equal(run([{cardId:'talent-m02',baseVersion:1,basis:'request',sourceIds:['g9'],patch:{tier:'P0'}}],[ask]).proposals.length,1);
 assert.equal(reconcileReply('M02 按原版重出一张修订卡。',[],[{cardId:'talent-m02',why:'没找到明确的修改要求'}]),'这次没出成修订卡：M02（没找到明确的修改要求）。');
});
test('批注里直接写“改成…”算修改要求',async()=>{
 const {revisionRequest}=await import('./nexus-policy.mjs');
 assert.ok(revisionRequest('19号周会肯定用不上，推送还没修好。改成26号一次就行'));
 assert.ok(!revisionRequest('改成什么样都行吗？'));
});
test('直接 @Nexus 说要改、要出卡，不管怎么措辞都算明确要求',()=>{
 const ask={id:'g10',channel:'group',author:'刘明华',text:'@Nexus 刚才我和梦怡说定了：M02 验收删掉第二条，只看到岗。出个卡给她'};
 assert.equal(run([{cardId:'talent-m02',baseVersion:1,basis:'request',sourceIds:['g10'],patch:{checks:['**到岗：**1人']}}],[ask]).proposals.length,1);
});
