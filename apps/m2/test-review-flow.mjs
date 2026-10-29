import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion,insightOwed,insightView} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {queueProposals,applyOwnerAnnotations} from './nexus-memory.mjs';
import {reviewHomeGroups,reviewTree} from './review-display.mjs';
import {exportMarkdown,parseStandardMarkdown,prepareTransfer,applyTransfer,transferCards,transferStamp,assertImportGrounded} from './markdown-transfer.mjs';
const facts=[{ref:'task-a',item:'任务甲',owner:'孙铭泽',status:'未达成',evidence:'原记录甲',gap:'未完成'},{ref:'task-b',item:'任务乙',owner:'孙铭泽',status:'未达成',evidence:'原记录乙',gap:'未完成'}];
const fresh=()=>installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,result:'客户使用',checks:['上线'],children:[{id:'bf01-m1',level:'mission',title:'首用',owner:'孙铭泽',version:1,result:'正式使用',checks:['验收'],children:[]}]}]),{period:'2026-10',reviews:[{unit:'company',level:'company',ref:'company',title:'公司',owner:'刘明华',verdict:'未达成',verdictReason:'原',facts:[],nextInputs:[]},{unit:'bf01',level:'ru',ref:'bf01',parent:'company',title:'灯塔复盘',owner:'刘明华',verdict:'未达成',verdictReason:'原',facts:[],nextInputs:[]},{unit:'bf01',level:'mission',ref:'bf01-m1',parent:'bf01',title:'首用复盘',owner:'孙铭泽',verdict:'未达成',verdictReason:'原',facts,nextInputs:[{ref:'task-a',type:'继续',text:'完成任务甲'}]}]});
const id='rv:bf01-m1',po='rv:bf01';
const revise=(s,actor,patch)=>applyAction(s,actor,{type:'revise',cardId:id,baseVersion:currentVersion(s.cards[id]).number,patch});
test('首页按签字职责分组且同卡不重复，已确认个人条目保留',()=>{
 let s=fresh();const actor=memberActor('member-03',s),p={...actor,missions:actor.missionDri};
 let tree=reviewTree(sharedProjection(s,actor).drafts);const groups=reviewHomeGroups(tree.nodes,p);
 assert.equal(groups.confirm[0].person,'孙铭泽');assert.equal(groups.watch[0].node.id,po);
 assert.equal(new Set([...groups.confirm,...groups.watch].flatMap(e=>e.cards.map(n=>n.id))).size,2);
 s=applyAction(s,actor,{type:'insight',cardId:id,text:'分析'});s=applyAction(s,actor,{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});tree=reviewTree(sharedProjection(s,actor).drafts);assert.equal(reviewHomeGroups(tree.nodes,p).confirm[0].cards[0].status,'已确认');
});
test('实际Task状态改变进个人房间，Mission判定改变进PO；出候选不发变化通知',()=>{
 let s=fresh(),actor=memberActor('member-03',s);const patch={facts:facts.map((f,i)=>i?f:{...f,status:'部分达成'})};
 queueProposals(s,'person:member-03',[{cardId:id,baseVersion:1,patch,sourceIds:[],reason:'补证'}]);assert.equal(s.messages.filter(m=>m.reviewTransition).length,0);
 s=applyAction(s,actor,{type:'acceptProposal',cardId:id,proposalId:s.proposals[0].id});
 const n=s.messages.filter(m=>m.reviewTransition);assert.equal(n.length,1);assert.equal(n[0].scope,'person:member-03');assert.match(n[0].text,/孙铭泽.*任务甲.*未达成.*部分达成/);
 s=revise(s,actor,{verdict:'部分达成'});assert.equal(s.messages.filter(m=>m.reviewTransition).length,2);assert.equal(s.messages.filter(m=>m.reviewTransition).at(-1).scope,'bf01');assert.equal(currentVersion(s.cards[po]).content.verdict,'未达成');
 assert.throws(()=>revise(s,actor,{verdict:'部分达成'}),/没有变化/);
});
test('强制洞察仅签字人，确认后快照立即汇PO，未确认编辑不泄露且重确认替换去重',()=>{
 let s=fresh();const actor=memberActor('member-03',s),ceo=memberActor('member-01',s);
 assert.deepEqual(insightOwed(s,s.cards[id]),['孙铭泽']);assert.deepEqual(insightOwed(s,s.cards[po]),['刘明华']);
 s=applyAction(s,actor,{type:'insight',cardId:id,text:'这是一条真实洞察'});assert.equal(insightView(s,s.cards[po],ceo).items.length,0);
 s=applyAction(s,actor,{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});let items=insightView(s,s.cards[po],ceo).items;assert.equal(items.length,1);assert.equal(items[0].author,'孙铭泽');assert.equal(items[0].source.label,'Mission 1');
 s=applyAction(s,actor,{type:'editInsight',cardId:id,insightId:s.insights[id][0].id,text:'新草稿不该泄露'});assert.equal(insightView(s,s.cards[po],ceo).items[0].text,'这是一条真实洞察');
 s=revise(s,actor,{verdictReason:'新的判定说明'});assert.equal(insightView(s,s.cards[po],ceo).items[0].text,'这是一条真实洞察');
 s=applyAction(s,actor,{type:'confirm',cardId:id,baseVersion:2,slot:'missionDri'});items=insightView(s,s.cards[po],ceo).items;assert.equal(items.length,1);assert.equal(items[0].text,'新草稿不该泄露');
});
test('同卡不同ref拆卡，倒序逐张接受不互相覆盖，同ref人工变化归档冲突',()=>{
 let s=fresh(),actor=memberActor('member-03',s);const patch={facts:facts.map(f=>({...f,evidence:'修订'+f.item}))};queueProposals(s,'person:member-03',[{cardId:id,baseVersion:1,patch,sourceIds:[],reason:'两项意见'}]);assert.equal(s.proposals.length,2);
 assert.equal(applyOwnerAnnotations(s,'person:member-03').proposals[0].status,'pending');
 const [a,b]=s.proposals;s=applyAction(s,actor,{type:'acceptProposal',cardId:id,proposalId:b.id});assert.equal(s.proposals[0].baseVersion,2);s=applyAction(s,actor,{type:'acceptProposal',cardId:id,proposalId:a.id});assert.deepEqual(currentVersion(s.cards[id]).content.facts.map(f=>f.evidence),['修订任务甲','修订任务乙']);
 s=fresh();queueProposals(s,'person:member-03',[{cardId:id,baseVersion:1,patch,sourceIds:[],reason:'两项意见'}]);s=revise(s,actor,{facts:facts.map((f,i)=>i?f:{...f,evidence:'人工改甲'})});assert.equal(s.proposals[0].status,'superseded');assert.equal(s.proposals[1].status,'pending');assert.throws(()=>applyAction(s,actor,{type:'acceptProposal',cardId:id,proposalId:s.proposals[0].id}),/归档/);
});
test('重复或缺失ref不按位置拆卡',()=>{for(const rows of [facts.map(f=>({...f,ref:'dup'})),facts.map(({ref,...f})=>f)]){const s=fresh();s.cards[id].versions[0].content.facts=rows;queueProposals(s,'person:member-03',[{cardId:id,baseVersion:1,patch:{facts:rows.map(f=>({...f,evidence:'新'}))},sourceIds:[],reason:'意见'}]);assert.equal(s.proposals.length,1);}});
test('复盘MD确定解析、预览不写state，确认不导入签字，历史保留',()=>{
 const s=fresh(),actor=memberActor('member-03',s),selection={stage:'review',rootId:id};const markdown=exportMarkdown(s,actor,selection),rows=parseStandardMarkdown(markdown);rows[0].fields.verdictReason='仅主动导入的说明';const original=JSON.stringify(s);
 const p=prepareTransfer(s,actor,selection,rows);assert.equal(JSON.stringify(s),original);const next=applyTransfer(s,actor,p.changes);assert.equal(currentVersion(next.cards[id]).number,2);assert.equal(next.cards[id].versions[0].content.verdictReason,'原');assert.deepEqual(currentVersion(next.cards[id]).signatures,[]);assert.equal(JSON.stringify(s),original);
 const changed=revise(s,actor,{verdictReason:'人工新改'});assert.notEqual(transferStamp(changed,transferCards(changed,actor,selection)),p.stamp);assert.throws(()=>prepareTransfer(changed,actor,selection,rows),/版本/);
});
test('MD注入权限/签字/未知对象被拒；跨对象任一失败不产生部分写入',()=>{
 const s=fresh(),actor=memberActor('member-03',s),selection={stage:'review',rootId:id},rows=parseStandardMarkdown(exportMarkdown(s,actor,selection));
 assert.throws(()=>prepareTransfer(s,actor,selection,[{...rows[0],fields:{signatures:[]}}]),/非模板/);
 assert.throws(()=>prepareTransfer(s,actor,selection,[{...rows[0],id:po}]),/范围/);
 rows[0].fields.facts[0].actor={ceo:true};assert.throws(()=>prepareTransfer(s,actor,selection,rows),/身份/);
 const original=JSON.stringify(s);assert.throws(()=>applyTransfer(s,actor,[{cardId:id,baseVersion:1,patch:{verdictReason:'拟修改'}},{cardId:po,baseVersion:1,patch:{verdictReason:'越权'}}]));assert.equal(JSON.stringify(s),original);
});
test('拆解MD支持当前对象及下级，空白模板无签字或业务确认',()=>{
 const s=fresh(),actor=memberActor('member-01',s),selection={stage:'plan',rootId:'bf01'};const rows=parseStandardMarkdown(exportMarkdown(s,actor,selection));assert.equal(rows.length,2);assert.equal(rows[1].fields.result,'正式使用');const blank=parseStandardMarkdown(exportMarkdown(s,actor,selection,{blank:true}));assert.equal(blank[0].fields.result,'');assert.ok(!('signatures'in blank[0].fields));assert.equal(parseStandardMarkdown('# 非标准文件'),null);
});

test('非标准模型整理不能补写文件没有的事实',()=>{const s=fresh();assert.throws(()=>assertImportGrounded(s,[{id,fields:{verdictReason:'验收全部通过'}}],'请修改复盘，保持未达成'),/未提供/);assert.doesNotThrow(()=>assertImportGrounded(s,[{id,fields:{verdictReason:'缺场次日期'}}],'判定理由：缺场次日期'));});

test('重新装入复盘将已确认洞察快照归档，旧快照不串入新一轮',()=>{
 let s=fresh(),actor=memberActor('member-03',s);s=applyAction(s,actor,{type:'insight',cardId:id,text:'上一轮已确认洞察'});s=applyAction(s,actor,{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});
 const next=installReviewRound(s,{period:'2026-11',reviews:[{unit:'bf01',level:'mission',ref:'bf01-m1',parent:'bf01',title:'新复盘',owner:'孙铭泽',verdict:'未达成',verdictReason:'新',facts,nextInputs:[]}]});
 assert.equal(next.insightPublications,undefined);assert.ok(next.reviewArchives.some(a=>a.insightPublications?.[id]?.items?.[0]?.text==='上一轮已确认洞察'));
});

test('privacy: unconfirmed new insight after reveal never enters group',()=>{
 let s=fresh();const a=memberActor('member-03',s),ceo=memberActor('member-01',s);s.insightsRevealed={at:new Date().toISOString()};
 s=applyAction(s,a,{type:'insight',cardId:id,text:'PRIVATE_UNCONFIRMED_NEW'});
 assert.ok(!JSON.stringify(sharedProjection(s,ceo).records).includes('PRIVATE_UNCONFIRMED_NEW'));
});
test('privacy: edit after confirmed snapshot never broadcasts draft',()=>{
 let s=fresh();const a=memberActor('member-03',s),ceo=memberActor('member-01',s);
 s=applyAction(s,a,{type:'insight',cardId:id,text:'CONFIRMED_ORIGINAL'});s=applyAction(s,a,{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});s.insightsRevealed={at:new Date().toISOString()};
 s=applyAction(s,a,{type:'editInsight',cardId:id,insightId:s.insights[id][0].id,text:'PRIVATE_POST_CONFIRM_EDIT'});
 assert.equal(insightView(s,s.cards[po],ceo).items[0].text,'CONFIRMED_ORIGINAL');assert.ok(!JSON.stringify(sharedProjection(s,ceo).records).includes('PRIVATE_POST_CONFIRM_EDIT'));
});
test('privacy: legacy confirmed data without publication cannot leak later edit',()=>{
 let s=fresh();const a=memberActor('member-03',s),ceo=memberActor('member-01',s);
 s=applyAction(s,a,{type:'insight',cardId:id,text:'LEGACY_CONFIRMED'});s=applyAction(s,a,{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});delete s.insightPublications;
 s=applyAction(s,a,{type:'editInsight',cardId:id,insightId:s.insights[id][0].id,text:'PRIVATE_LEGACY_EDIT'});
 assert.ok(!JSON.stringify(insightView(s,s.cards[po],ceo)).includes('PRIVATE_LEGACY_EDIT'));
});
test('notice: duplicate refs with unchanged row statuses must not fake transition',()=>{
 let s=fresh();const a=memberActor('member-03',s);const rows=[{...facts[0],ref:'dup',status:'未达成'},{...facts[1],ref:'dup',status:'达成'}];s.cards[id].versions[0].content.facts=rows;
 s=revise(s,a,{facts:rows.map(x=>({...x,evidence:x.evidence+'补来源'}))});assert.equal(s.messages.filter(m=>m.reviewTransition).length,0);
});

test('旧确认值缺签字时间或编辑晚于签字时不冒充已确认文本',()=>{
 for(const mode of ['no-signature-time','edited-later']){
  let s=fresh(),actor=memberActor('member-03',s),ceo=memberActor('member-01',s);s=applyAction(s,actor,{type:'insight',cardId:id,text:'不能证实的旧文本'});s=applyAction(s,actor,{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});delete s.insightPublications;
  if(mode==='no-signature-time')delete s.cards[id].versions[0].signatures[0].createdAt;else s.insights[id][0].updatedAt='2099-01-01T00:00:00Z';
  assert.equal(insightView(s,s.cards[po],ceo).items.length,0);
  s=applyAction(s,actor,{type:'editInsight',cardId:id,insightId:s.insights[id][0].id,text:'新草稿'});assert.equal(insightView(s,s.cards[po],ceo).items.length,0);
 }
});

test('卡片导入导出只选当前卡，缺少卡片或跨卡及多对象均拒绝',()=>{
 const s=fresh(),actor=memberActor('member-01',s),selection={stage:'plan',rootId:'bf01',onlyRoot:true};
 assert.deepEqual(transferCards(s,actor,selection).map(c=>c.id),['bf01']);
 const rows=parseStandardMarkdown(exportMarkdown(s,actor,selection));assert.equal(rows.length,1);
 assert.throws(()=>transferCards(s,actor,{stage:'plan',onlyRoot:true}),/具体卡片/);
 const child=parseStandardMarkdown(exportMarkdown(s,actor,{stage:'plan',rootId:'bf01-m1',onlyRoot:true}))[0];
 assert.throws(()=>prepareTransfer(s,actor,selection,[child]),/范围/);
 assert.throws(()=>prepareTransfer(s,actor,selection,[rows[0],child]),/范围/);
 assert.throws(()=>prepareTransfer(s,actor,selection,[rows[0],rows[0]]),/重复/);
 rows[0].fields.result='粘贴的新结果';const before=JSON.stringify(s),preview=prepareTransfer(s,actor,selection,rows);
 assert.equal(preview.changes.length,1);assert.equal(preview.changes[0].cardId,'bf01');assert.equal(JSON.stringify(s),before);
 const after=applyTransfer(s,actor,preview.changes);assert.equal(currentVersion(after.cards['bf01-m1']).number,1);
});
