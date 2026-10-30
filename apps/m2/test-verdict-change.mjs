import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion,verdictDeciders,cardStatus as cardStatusOf} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {queueProposals,applyOwnerAnnotations} from './nexus-memory.mjs';
// 判定变化一律走修订卡 (陈溪南 2026-10-22 走查第 1 条): the Mission owner saying "判严了" must not change the verdict by itself.
const sample={period:'2026-10',reviews:[
 {unit:'company',level:'company',ref:'company',title:'词元云集 10 月',owner:'刘明华',verdict:'未达成',verdictReason:'r',targets:[],causes:[],nextInputs:[]},
 {unit:'bf01',level:'ru',ref:'bf01',title:'灯塔',owner:'刘明华',verdict:'未达成',verdictReason:'r',targets:[],causes:[],nextInputs:[],parent:'company'},
 {unit:'bf01',level:'mission',ref:'bf01-m1',title:'首用',owner:'孙铭泽',verdict:'未达成',verdictReason:'没有真实使用记录',targets:[],causes:[],nextInputs:[],parent:'bf01'}]};
const fresh=()=>installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,children:[]}]),sample,{label:'10 月复盘'});
test('个人复盘只由负责人确认（2026-10-27）：负责人自己改判定直接生效；别人提的改判交给负责人决定',()=>{
 let s=fresh();const sun=memberActor('member-03',s),ceo=memberActor('member-01',s);
 s=applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:1,patch:{verdict:'部分达成'},reason:'判严了，10/20 已有一次真实使用'});
 assert.equal(currentVersion(s.cards['rv:bf01-m1']).content.verdict,'部分达成','唯一签字人改自己的判定，不再出修订卡');
 assert.deepEqual(verdictDeciders(s,s.cards['rv:bf01-m1'],{verdictChange:{by:['member-01']}}),['孙铭泽'],'CEO 或单元 DRI 提的改判由负责人决定');
 assert.throws(()=>applyAction(s,ceo,{type:'revise',cardId:'rv:bf01-m1',baseVersion:2,patch:{verdict:'达成'}}),/负责人|修订/,'单元 DRI、CEO 不直接改个人复盘');
});
test('Nexus 按负责人批注出的判定修订卡不会自动生效；其他字段照旧由负责人批注直接改',()=>{
 let s=fresh();s.comments.push({id:'c1',author:'member-03',channel:'group',scope:'bf01',cardId:'rv:bf01-m1',text:'判严了，应判部分达成',createdAt:new Date().toISOString()});
 s=queueProposals(s,'bf01',[{cardId:'rv:bf01-m1',baseVersion:1,patch:{verdict:'部分达成'},reason:'负责人说判严了',sourceIds:['c1']}]);
 const p=s.proposals.at(-1);assert.equal(p.verdictChange.to,'部分达成');
 s=applyOwnerAnnotations(s,'bf01');
 assert.equal(s.proposals.at(-1).status,'pending');assert.equal(currentVersion(s.cards['rv:bf01-m1']).content.verdict,'未达成');
});
test('签字方反对有出路：进负责人的待我处理；两人意见相反的议题不标已定；提到“判定”就算说到这张复盘',async()=>{
 const {openObjections,todoItems}=await import('./todo.mjs');const {reviewTodos}=await import('./review-display.mjs');
 const {contested,mergeTopics}=await import('./nexus-memory.mjs');const {reviewMention}=await import('./nexus-review.mjs');
 const said=[{id:'a',author:'孙铭泽',text:'判严了，应判部分达成',createdAt:'2026-10-22T10:00:00Z'},{id:'b',author:'刘明华',text:'不同意，改回未达成',createdAt:'2026-10-22T10:05:00Z'}];
 assert.deepEqual(openObjections(said,'孙铭泽').map(c=>c.id),['b']);
 assert.deepEqual(openObjections([...said,{id:'c',author:'孙铭泽',text:'好，我补证据',createdAt:'2026-10-22T10:09:00Z'}],'孙铭泽'),[]);
 const node={id:'rv:bf01-m1',level:'mission',unit:'bf01',owner:'孙铭泽',status:'待确认',causes:[],signatures:[]};
 assert.equal(reviewTodos([node],{name:'孙铭泽',unitDri:[]},{'rv:bf01-m1':said})[0].kind,'objection');
 const plan=[{id:'bf01-m2',level:'mission',owner:'孙铭泽',signatures:[],children:[]}];
 assert.ok(todoItems({units:plan,comments:{'bf01-m2':said},profile:{missions:['bf01-m2']},name:'孙铭泽'}).some(i=>i.kind==='objection'&&i.rank===1));
 const topic={title:'判定',stage:'已定',status:'agreement',sourceIds:['a','b'],quotes:[]};
 assert.equal(contested(topic,said),true);
 const [t]=mergeTopics([],[topic],said);assert.equal(t.stage,'讨论');
 assert.equal(reviewMention('Mission 02 的判定请按我的批注改回未达成',{kind:'review',id:'rv:agents-m2',level:'mission'}),true);
});
test('下级改了日期，上级还写着旧日期：上级标“下级有调整”、点名旧日期、提醒上级负责人；上级负责人修订或签字后消失',()=>{
 const mission={id:'bf01-m2',unit:'bf01',level:'mission',title:'方案确认',owner:'孙铭泽',time:'2026-11-03—2026-11-06',checks:['11/05 方案初稿','11/06 刘明华确认'],children:[]};
 let s=createCollaborationState([{id:'bf01',unit:'bf01',level:'po',title:'灯塔',owner:'刘明华',milestones:['11/06 方案经确认'],checks:['刘明华 11/06 前确认'],version:1,children:[mission]}]);
 const sun={id:'member-03',name:'孙铭泽',visibleUnits:['bf01'],missionDri:['bf01-m2'],unitDri:[]},ceo=memberActor('member-01',s);
 s=applyAction(s,sun,{type:'revise',cardId:'bf01-m2',baseVersion:1,patch:{checks:['11/07 方案初稿','11/09 刘明华确认']}});
 const d=s.cards.bf01.downstreamChange;assert.equal(d.cardId,'bf01-m2');assert.deepEqual(d.staleDates,['11/06']);
 assert.equal(cardStatusOf(s.cards.bf01),'下级有调整 · 待核对');
 assert.ok(s.messages.some(m=>m.cardId==='bf01'&&/还写着 11\/06/.test(m.text)&&m.text.includes('@刘明华')));
 s=applyAction(s,ceo,{type:'confirm',cardId:'bf01',slot:'ceo',baseVersion:1});assert.equal(s.cards.bf01.downstreamChange,undefined);
});
test('个人复盘判定或事实证据改了：不再给单元复盘标“下级有调整”，而是排一项让 Nexus 判断对单元复盘有没有实质影响（2026-10-27）',()=>{
 let s=fresh();const sun=memberActor('member-03',s);
 s=applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:1,patch:{verdict:'部分达成'},reason:'有一次真实使用'});
 const facts=[{ref:'t1',item:'首用',owner:'孙铭泽',status:'部分达成',evidence:'10/20 有一次真实使用（群聊记录）',gap:''}];
 s=applyAction(s,sun,{type:'revise',cardId:'rv:bf01-m1',baseVersion:2,patch:{facts},reason:'10/20 有一次真实使用'});
 assert.equal(currentVersion(s.cards['rv:bf01-m1']).content.facts[0].status,'部分达成','事实证据直接改成新版本');
 assert.equal(s.cards['rv:bf01'].downstreamChange,undefined);
 assert.equal(s.reviewCascadeQueue?.length||0,0,'未确认判定和未被引用Task事实不传播');
 assert.ok(!s.messages.some(m=>m.scope==='bf01'&&/修改了/.test(m.text)),'个人草稿不广播单元群');
});
test('修订卡不重复、不过期：卡在上级改动后已被改过，下级对齐的卡不再发；理由引用的日期卡上已没有，不发；上级再改或确认后，旧的对齐卡归档',async()=>{
 const {queueProposals,staleDates}=await import('./nexus-memory.mjs');
 const task={id:'bf01-m2-t1',unit:'bf01',level:'task',title:'初稿',owner:'孙铭泽',checks:['11/07 初稿'],children:[]};
 let s=createCollaborationState([{id:'bf01-m2',unit:'bf01',level:'mission',title:'方案',owner:'孙铭泽',checks:['11/07'],version:1,children:[task]}]);
 s.cards['bf01-m2'].versions.push({...s.cards['bf01-m2'].versions[0],number:2,createdAt:'2026-10-22T10:00:00Z'});
 s.cards['bf01-m2-t1'].versions[0].createdAt='2026-10-22T09:00:00Z';
 const base={cardId:'bf01-m2-t1',baseVersion:1,patch:{checks:['11/09 初稿']},sourceIds:['n1'],basis:'cascade'};
 assert.equal(staleDates('本卡仍写 11/05、11/06',{checks:['11/07 初稿']}),true);
 let q=queueProposals(structuredClone(s),'bf01',[{...base,reason:'本卡仍写 11/05、11/06',fromParent:{id:'bf01-m2',version:2,at:'2026-10-22T10:00:00Z'}}]);assert.equal((q.proposals||[]).length,0,'理由引用的旧日期已不在卡上');
 q=queueProposals(structuredClone(s),'bf01',[{...base,reason:'上级改到 11/09',fromParent:{id:'bf01-m2',version:1,at:'2026-10-22T08:00:00Z'}}]);assert.equal(q.proposals.length,0,'上级已经又改了');
 const later=structuredClone(s);later.cards['bf01-m2-t1'].versions[0].createdAt='2026-10-22T11:00:00Z';
 q=queueProposals(later,'bf01',[{...base,reason:'上级改到 11/09',fromParent:{id:'bf01-m2',version:2,at:'2026-10-22T10:00:00Z'}}]);assert.equal(q.proposals.length,0,'卡已在上级改动后被改过');
 q=queueProposals(structuredClone(s),'bf01',[{...base,reason:'上级改到 11/09',fromParent:{id:'bf01-m2',version:2,at:'2026-10-22T10:00:00Z'}}]);assert.equal(q.proposals.length,1);
 // The Mission moves on to v3: the v2 alignment card is archived.
 const sun={id:'member-03',name:'孙铭泽',visibleUnits:['bf01'],missionDri:['bf01-m2'],unitDri:[]};
 q=applyAction(q,sun,{type:'revise',cardId:'bf01-m2',baseVersion:2,patch:{checks:['11/10']}});
 assert.equal(q.proposals[0].status,'superseded');
});
test('在卡片页发群消息：当前打开的卡记作这条消息说的卡',()=>{
 let s=fresh();const ceo=memberActor('member-01',s);
 s=applyAction(s,ceo,{type:'message',cardId:'bf01',text:'@Nexus 请按我的批注改回未达成',viewing:{id:'rv:bf01-m1'}});
 assert.deepEqual(s.messages.at(-1).context.selection,{id:'rv:bf01-m1',version:1});
 // The page may send it as context.selection too.
 s=applyAction(s,ceo,{type:'message',cardId:'bf01',text:'@Nexus 判定再看一下',context:{selection:{id:'rv:bf01',version:1}}});
 assert.equal(s.messages.at(-1).context.selection.id,'rv:bf01');
});
