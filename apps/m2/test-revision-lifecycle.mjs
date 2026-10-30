import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {queueProposals,applyOwnerAnnotations} from './nexus-memory.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {installReviewRound} from './review-round.mjs';
import {createRevisionAcknowledgements} from './revision-ack.mjs';
import {createProposalSummarizer} from './proposal-summary.mjs';
import {completeComparison} from './proposal-summary-input.mjs';
import {prepareTransfer,exportMarkdown,parseStandardMarkdown,applyTransfer} from './markdown-transfer.mjs';
const facts=[{ref:'a',item:'甲',owner:'孙铭泽',status:'未达成',evidence:'甲原记录',gap:'未完成'},{ref:'b',item:'乙',owner:'孙铭泽',status:'未达成',evidence:'乙原记录',gap:'未完成'}];
function fresh(){return installReviewRound(createCollaborationState([{id:'bf01',level:'po',title:'单元',owner:'刘明华',result:'原成果',children:[{id:'bf01-m1',unit:'bf01',level:'mission',title:'个人',owner:'孙铭泽',result:'原成果',children:[]}]}]),{period:'2026-10',reviews:[{ref:'company',unit:'company',level:'company',title:'公司',owner:'刘明华',verdict:'未达成',verdictReason:'公司原',facts:[],nextInputs:[]},{ref:'bf01',unit:'bf01',level:'ru',parent:'company',title:'单元复盘',owner:'刘明华',verdict:'未达成',verdictReason:'单元原',facts:[],nextInputs:[]},{ref:'bf01-m1',unit:'bf01',level:'mission',parent:'bf01',title:'个人复盘',owner:'孙铭泽',verdict:'未达成',verdictReason:'原理由',facts,nextInputs:[{ref:'a',type:'继续',text:'继续甲'}]}]});}
const id='rv:bf01-m1',scope='person:member-03',owner=s=>memberActor('member-03',s);
const p=(s,patch,order=1)=>({cardId:id,baseVersion:currentVersion(s.cards[id]).number,patch,reason:'补充',sourceIds:[],originSequence:order});
const sign=s=>{s=applyAction(s,owner(s),{type:'insight',cardId:id,text:'洞察'});return applyAction(s,owner(s),{type:'confirm',cardId:id,baseVersion:1,slot:'missionDri'});};
test('同ref新pending替换旧，来源和原patch留历史；旧点击409，不同ref保留',()=>{
 let s=fresh();queueProposals(s,scope,[p(s,{facts:facts.map((f,i)=>i?f:{...f,evidence:'旧建议'})})]);const old=structuredClone(s.proposals[0]);
 queueProposals(s,scope,[p(s,{facts:facts.map((f,i)=>i?f:{...f,evidence:'最新建议'})},2),p(s,{facts:facts.map((f,i)=>i?{...f,evidence:'乙新建议'}:f)},2)]);
 assert.equal(s.proposals[0].status,'superseded');assert.deepEqual(s.proposals[0].patch,old.patch);assert.equal(s.proposals.filter(p=>p.status==='pending').length,2);
 assert.throws(()=>applyAction(s,owner(s),{type:'acceptProposal',cardId:id,proposalId:old.id}),e=>e.status===409);
 const latest=s.proposals.find(p=>p.status==='pending');s=applyAction(s,owner(s),{type:'acceptProposal',cardId:id,proposalId:latest.id});assert.equal(s.proposals.filter(p=>p.status==='pending').length,1);assert.equal(currentVersion(s.cards[id]).content.facts[0].evidence,'最新建议');
});
test('已accepted历史不改，新候选可出；晚到旧结果不能盖最新pending；重复不叠卡',()=>{
 let s=fresh();queueProposals(s,scope,[p(s,{verdictReason:'第一版'},1)]);const first=s.proposals[0].id;s=applyAction(s,owner(s),{type:'acceptProposal',cardId:id,proposalId:first});const saved=JSON.stringify(s.proposals[0]);
 queueProposals(s,scope,[p(s,{verdictReason:'第二版'},3)]);queueProposals(s,scope,[p(s,{verdictReason:'晚到旧建议'},2)]);queueProposals(s,scope,[p(s,{verdictReason:'第二版'},3)]);
 assert.equal(JSON.stringify(s.proposals[0]),saved);assert.equal(s.proposals.filter(p=>p.status==='pending').length,1);assert.equal(s.proposals.at(-1).patch.verdictReason,'第二版');
});
test('复合patch仅替换重叠部分，不丢其他ref或字段',()=>{
 const s=fresh();queueProposals(s,scope,[p(s,{facts:facts.map(f=>({...f,evidence:'旧'+f.item})),verdictReason:'仍需核对'},1)]);
 queueProposals(s,scope,[p(s,{facts:facts.map((f,i)=>i?f:{...f,evidence:'甲最新'})},2)]);
 assert.equal(s.proposals[0].status,'superseded');const rest=s.proposals.find(p=>p.carriedFrom);assert.equal(rest.patch.facts[0].evidence,'甲原记录');assert.equal(rest.patch.facts[1].evidence,'旧乙');assert.equal(rest.patch.verdictReason,'仍需核对');
});
test('手工修改后旧模型不覆盖；过期下级来源不能接受或覆盖当前候选',()=>{
 let s=fresh();const old=p(s,{verdictReason:'旧模型'});s=applyAction(s,owner(s),{type:'revise',cardId:id,baseVersion:1,patch:{verdictReason:'手工新内容'}});queueProposals(s,scope,[old]);assert.equal(s.proposals.length,0);
 queueProposals(s,'bf01',[{cardId:'rv:bf01',baseVersion:1,patch:{verdictReason:'上级建议'},sourceIds:[],fromMission:{id,version:1}}]);assert.equal(s.proposals.length,0);
});
test('负责人明确批注、群话、个人房间修改均可自动正文，不代签；闲聊疑问歧义不自动',()=>{
 for(const type of ['comment','message'])for(const text of ['把判定理由改为缺验收记录','是否把判定理由改为缺验收记录？','如果把判定理由改为缺验收记录呢','这是什么意思','不要把判定理由改为缺验收记录']){
  let s=fresh();s=applyAction(s,owner(s),{type,cardId:id,baseVersion:1,block:'verdictReason',text});const event=s[type==='comment'?'comments':'messages'].at(-1);queueProposals(s,scope,[{...p(s,{verdictReason:'缺验收记录'}),sourceIds:[event.id]}]);s=applyOwnerAnnotations(s,scope);
  const yes=text==='把判定理由改为缺验收记录';assert.equal(s.proposals[0].status,yes?'accepted':'pending',text);assert.equal(currentVersion(s.cards[id]).number,yes?2:1);assert.equal(currentVersion(s.cards[id]).signatures.length,0);
 }
});
test('个人群未选卡但准确点名唯一标题可自动，含糊目标不自动；跨级来源不自动',()=>{
 for(const text of ['把个人复盘的判定理由改为缺验收记录','把判定理由改为缺验收记录']){let s=fresh();s=applyAction(s,owner(s),{type:'message',cardId:'rv:person:孙铭泽',text});queueProposals(s,scope,[{...p(s,{verdictReason:'缺验收记录'}),sourceIds:[s.messages.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,text.includes('个人复盘')?'accepted':'pending');}
 let s=fresh();queueProposals(s,scope,[{...p(s,{verdictReason:'跨级'}),fromMission:{id,version:1},basis:'cascade'}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');
});
test('已确认卡自动应用被挡；提醒取消不写，显式继续留旧签字，新版无签字',()=>{
 let s=sign(fresh());s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text:'把判定理由改为新理由'});queueProposals(s,scope,[{...p(s,{verdictReason:'新理由'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');
 const before=JSON.stringify(s),action={type:'acceptProposal',cardId:id,proposalId:s.proposals[0].id};assert.throws(()=>applyAction(s,owner(s),action),e=>e.code==='RECONFIRM_REQUIRED');assert.equal(JSON.stringify(s),before);
 s=applyAction(s,owner(s),{...action,reconfirmVersion:1});assert.equal(s.cards[id].versions[0].signatures.length,1);assert.equal(currentVersion(s.cards[id]).signatures.length,0);assert.equal(currentVersion(s.cards[id]).number,2);
});
test('确认凭证绑定身份、完整patch、版本及轮次，原始字段无法绕过；权限/锁重验',()=>{
 const s=sign(fresh()),acks=createRevisionAcknowledgements(),actor=owner(s),request={type:'revise',cardId:id,baseVersion:1,patch:{verdictReason:'继续新改'}},run=(state,a,req)=>acks.run(state,a,req,value=>applyAction(state,a,value));let token;
 assert.throws(()=>run(s,actor,{...request,reconfirmVersion:1,auto:true}),e=>{token=e.reconfirmToken;return e.code==='RECONFIRM_REQUIRED'&&!!token;});
 assert.throws(()=>run(s,memberActor('member-01',s),{...request,ackToken:token}),e=>e.status===409);
 assert.throws(()=>run(s,actor,{...request,patch:{verdictReason:'换内容'},ackToken:token}),e=>e.status===409);
 const changed=structuredClone(s);changed.round={id:'other'};assert.throws(()=>run(changed,actor,{...request,ackToken:token}),e=>e.status===409);
 const locked=structuredClone(s);locked.cards['rv:bf01'].confirmedVersion=1;assert.throws(()=>run(locked,actor,{...request,ackToken:token}),/不能再改/);
 const next=run(s,actor,{...request,ackToken:token});assert.equal(currentVersion(next.cards[id]).number,2);assert.throws(()=>run(s,actor,{...request,ackToken:token}),e=>e.status===409);
});
test('拆解已确认及部分签字均需提醒，继续不继承签字',()=>{
 for(const complete of [false,true]){let s=fresh();const card=s.cards['bf01-m1'];card.versions[0].signatures=[{slot:'missionDri',actorId:'member-03'}];if(complete)card.confirmedVersion=1;
 const a={type:'revise',cardId:card.id,baseVersion:1,patch:{result:'新成果'}};assert.throws(()=>applyAction(s,{...owner(s),missionDri:['bf01-m1']},a),e=>e.code==='RECONFIRM_REQUIRED');s=applyAction(s,{...owner(s),missionDri:['bf01-m1']},{...a,reconfirmVersion:1});assert.equal(s.cards[card.id].versions[0].signatures.length,1);assert.equal(currentVersion(s.cards[card.id]).signatures.length,0);}
});
test('MD已确认卡允许只读预览，真正应用要求确认，不能通过导入绕过',()=>{
 const s=sign(fresh()),actor=owner(s),selection={stage:'review',rootId:id,onlyRoot:true},rows=parseStandardMarkdown(exportMarkdown(s,actor,selection));rows[0].fields.verdictReason='MD新理由';const before=JSON.stringify(s),preview=prepareTransfer(s,actor,selection,rows);assert.equal(JSON.stringify(s),before);
 assert.throws(()=>applyTransfer(s,actor,preview.changes),e=>e.code==='RECONFIRM_REQUIRED');const next=applyTransfer(s,actor,preview.changes,{reconfirmVersion:1});assert.equal(currentVersion(next.cards[id]).signatures.length,0);assert.equal(next.cards[id].versions[0].signatures.length,1);
});
test('无上级实际引用的下级正文变化不广播，不自动改上级',()=>{let s=fresh();s=applyAction(s,owner(s),{type:'revise',cardId:id,baseVersion:1,patch:{verdictReason:'下级新理由'}});assert.ok(!s.messages.some(m=>m.scope==='bf01'&&m.author==='Nexus'&&m.text.includes('修改了')));assert.equal(currentVersion(s.cards['rv:bf01']).number,1);assert.equal(s.reviewCascadeQueue?.length||0,0);});
test('简单状态无需模型；附带合法摘要复用；复杂失败完整对照只调用一次且不改patch',async()=>{
 let calls=0;const summarize=createProposalSummarizer({complete:async()=>{calls++;throw Error('timeout');}}),node={level:'mission',title:'复盘'};
 const simple={id:'simple',cardId:id,before:{verdict:'未达成'},patch:{verdict:'达成'}};assert.equal((await summarize(simple,node)).changes[0].after,'达成');assert.equal(calls,0);
 const complex={id:'complex',cardId:id,before:{verdictReason:'原文带有负责人报告。'.repeat(10)},patch:{verdictReason:'新文仍无真实验收记录。'.repeat(10)}};const raw=JSON.stringify(complex);const full=await summarize(complex,node,{actorId:'a'});assert.equal(full.full,true);assert.equal(full.changes[0].after,complex.patch.verdictReason);await summarize(complex,node,{actorId:'a'});assert.equal(calls,1);await summarize(complex,node,{actorId:'b'});assert.equal(calls,2);assert.equal(JSON.stringify(complex),raw);
 const attached={...complex,id:'attached',displaySummary:{changes:[{index:0,before:'负责人报告',after:'仍无真实验收记录'}]}};assert.equal((await summarize(attached,node)).changes[0].after,'仍无真实验收记录');assert.equal(calls,2);
 assert.equal(completeComparison({...complex,patch:{verdictReason:'[E12] **完整原文**'}},node).changes[0].after,'[E12] **完整原文**');
});

test('自动应用不越过明确字段或事实行，单人签字职责的明确判定请求可应用',()=>{
 let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text:'把判定理由改为新的理由'});queueProposals(s,scope,[{...p(s,{verdictReason:'新的理由',verdict:'达成'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');
 s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'facts',item:0,text:'把证据改为新的证据'});queueProposals(s,scope,[{...p(s,{facts:facts.map((f,i)=>i?{...f,evidence:'乙的额外修改'}:f)}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');
 s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdict',text:'把结果判定改为达成'});queueProposals(s,scope,[{...p(s,{verdict:'达成'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'accepted');assert.equal(currentVersion(s.cards[id]).content.verdict,'达成');assert.equal(currentVersion(s.cards[id]).signatures.length,0);
});
test('已存下级来源过期时接受409，投影为不可采纳；晚到父子版本分析不覆盖人工改动',async()=>{
 const {reviewCascadeProposal}=await import('./review-cascade.mjs');let s=fresh();queueProposals(s,'bf01',[{cardId:'rv:bf01',baseVersion:1,patch:{verdictReason:'旧来源'},sourceIds:[],fromMission:{id,version:1}}]);const pid=s.proposals[0].id;
 s=applyAction(s,owner(s),{type:'revise',cardId:id,baseVersion:1,patch:{verdictReason:'最新下级'}});assert.throws(()=>applyAction(s,memberActor('member-01',s),{type:'acceptProposal',cardId:'rv:bf01',proposalId:pid}),e=>e.status===409);assert.equal(Object.values(sharedProjection(s,memberActor('member-01',s)).records).flat().find(x=>x.id===pid).stale,true);
 assert.equal(reviewCascadeProposal(s,{childId:id,parentId:'rv:bf01',toVersion:1},{impact:true,patch:{verdictReason:'旧分析'}}).proposal,null);
 s=applyAction(s,memberActor('member-01',s),{type:'revise',cardId:'rv:bf01',baseVersion:1,patch:{verdictReason:'人工上级'}});assert.equal(reviewCascadeProposal(s,{childId:id,parentId:'rv:bf01',toVersion:2,parentVersion:1},{impact:true,patch:{verdictReason:'晚到分析'}}).proposal,null);
});

test('正向指令须是本人真实意图，反对、引用、假设与问法均不授自动权',()=>{
 for(const text of ['我不同意把判定理由改为已通过验收','我反对把判定理由改为已通过验收','我不认可把判定理由改为已通过验收','他说把判定理由改为已通过验收','仅转述原话，把判定理由改为已通过验收','我想知道把判定理由改为已通过验收会怎样','把我不同意把判定理由改为已通过验收这句话记录下来','“把判定理由改为已通过验收”是个例子','把判定理由改为已通过验收，我反对','请不要把判定理由改为已通过验收','如果把判定理由改为已通过验收','建议讨论把判定理由改为已通过验收']){
 let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text});const patch={verdictReason:'已通过验收'};queueProposals(s,scope,[{...p(s,patch),sourceIds:[s.comments.at(-1).id]}]);const original=JSON.stringify(s.proposals[0].patch);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending',text);assert.equal(currentVersion(s.cards[id]).number,1);assert.equal(JSON.stringify(s.proposals[0].patch),original);}
});
test('事实证据仅授权evidence，额外status/gap/owner保持整张pending且原patch不改',()=>{
 for(const extra of [{status:'达成'},{gap:'没有差距'},{owner:'刘明华'}]){let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'facts',item:0,text:'把这一项证据改为新的证据'});queueProposals(s,scope,[{...p(s,{facts:facts.map((f,i)=>i?f:{...f,evidence:'新的证据',...extra})}),sourceIds:[s.comments.at(-1).id]}]);const original=JSON.stringify(s.proposals[0].patch);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');assert.deepEqual(currentVersion(s.cards[id]).content.facts,facts);assert.equal(JSON.stringify(s.proposals[0].patch),original);}
 let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'facts',item:0,text:'把这一项证据改为新的证据'});queueProposals(s,scope,[{...p(s,{facts:facts.map((f,i)=>i?f:{...f,evidence:'新的证据'})}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'accepted');assert.equal(currentVersion(s.cards[id]).content.facts[0].status,'未达成');
});
test('明确目标字段优先于批注所在字段，不能顺带自动修改原批注字段',()=>{
 let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text:'把结果判定改为达成'});queueProposals(s,scope,[{...p(s,{verdict:'达成',verdictReason:'顺带改理由'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');assert.equal(currentVersion(s.cards[id]).number,1);
});
test('同源明确多ref可完整自动，但人工修改或其他来源不能借批次放宽版本检查',()=>{
 for(const manual of [false,true]){let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'facts',text:'把甲和乙的证据都改为负责人补充记录'});const source=s.comments.at(-1).id;queueProposals(s,scope,[{...p(s,{facts:facts.map(f=>({...f,evidence:'负责人补充记录'}))}),sourceIds:[source]}]);
 if(manual)s=applyAction(s,owner(s),{type:'revise',cardId:id,baseVersion:1,patch:{verdictReason:'人工改动'}});
 s=applyOwnerAnnotations(s,scope);assert.deepEqual(s.proposals.map(p=>p.status),manual?['pending','pending']:['accepted','accepted']);assert.deepEqual(currentVersion(s.cards[id]).content.facts.map(f=>f.evidence),manual?facts.map(f=>f.evidence):['负责人补充记录','负责人补充记录']);assert.equal(currentVersion(s.cards[id]).signatures.length,0);}
});

test('明确@Nexus本人指令可自动，@Nexus反对语句仍不授权',()=>{
 for(const text of ['@Nexus 把判定理由改为新理由','@Nexus 我不同意把判定理由改为新理由']){let s=fresh();s=applyAction(s,owner(s),{type:'message',cardId:id,baseVersion:1,block:'verdictReason',text});queueProposals(s,scope,[{...p(s,{verdictReason:'新理由'}),sourceIds:[s.messages.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,text.includes('不同意')?'pending':'accepted');}
});

test('礼貌和空格正向指令可落正文，新值必须来自本人明确内容',()=>{
 for(const text of ['请把判定理由改为新理由','请 把判定理由改为新理由','把判定理由改为 新理由']){let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text});queueProposals(s,scope,[{...p(s,{verdictReason:'新理由'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'accepted',text);}
 let s=fresh();s=applyAction(s,owner(s),{type:'comment',cardId:id,baseVersion:1,block:'verdictReason',text:'把判定理由改为新理由'});queueProposals(s,scope,[{...p(s,{verdictReason:'模型另添了已通过验收'}),sourceIds:[s.comments.at(-1).id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'pending');assert.equal(currentVersion(s.cards[id]).number,1);
});
test('个人群明确点名第二卡不借第一卡版本；真正手改后的旧来源仍不能自动',()=>{
 let s=fresh();const second='rv:bf01-m2';s.cards[second]=structuredClone(s.cards[id]);s.cards[second].id=second;s.cards[second].versions[0].content.id=second;s.cards[second].versions[0].content.title='第二复盘';
 s=applyAction(s,owner(s),{type:'revise',cardId:id,baseVersion:1,patch:{verdictReason:'第一卡新版本'}});
 s=applyAction(s,owner(s),{type:'message',cardId:'rv:person:孙铭泽',text:'把第二复盘的判定理由改为第二卡新理由'});const source=s.messages.at(-1);assert.equal(source.general,true);assert.equal(source.version,2);
 queueProposals(s,scope,[{cardId:second,baseVersion:1,patch:{verdictReason:'第二卡新理由'},sourceIds:[source.id]}]);s=applyOwnerAnnotations(s,scope);assert.equal(s.proposals[0].status,'accepted');assert.equal(currentVersion(s.cards[second]).content.verdictReason,'第二卡新理由');assert.equal(currentVersion(s.cards[id]).content.verdictReason,'第一卡新版本');
});
