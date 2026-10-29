import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCollaborationState,currentVersion,applyAction} from './governance.mjs';
import {queueProposals,applyOwnerAnnotations} from './nexus-memory.mjs';
import {proposalDelivery,deliveryNotice,withoutUnsentCardClaims} from './proposal-delivery.mjs';
import {roomLine,cardName,quietReply} from './nexus-policy.mjs';
const id='agents-m1',scope='agents';
function fresh(){return createCollaborationState([{id:scope,level:'po',title:'Agents',owner:'刘明华',result:'领域原成果',children:[{id,unit:scope,level:'mission',title:'供应选择',owner:'孙铭泽',result:'原成果',checks:['原验收'],children:[]},{id:'agents-m2',unit:scope,level:'mission',title:'合同',owner:'孙铭泽',result:'原成果乙',children:[]}]}]);}
const make=(patch,extra={})=>({cardId:id,baseVersion:1,patch,sourceIds:[],...extra});
function commit(state,planned){const ids=new Set((state.proposals||[]).map(p=>p.id));queueProposals(state,scope,planned);return proposalDelivery(state,ids,scope,planned);}
test('纠正旧pending后新候选实际入库，旧卡归档，按真实卡数/来源出回执',()=>{
 const s=fresh();queueProposals(s,scope,[make({result:'旧建议待补报价'},{originSequence:1})]);const old=s.proposals[0].id,p=make({result:'GPT 72折；Claude 8折；Gemini 7折'},{sourceIds:['price','update'],originSequence:2}),d=commit(s,[p]);
 assert.equal(s.proposals[0].status,'superseded');assert.equal(d.saved.length,1);assert.deepEqual(d.saved[0].sourceIds,['price','update']);assert.equal(d.outcomes[0].status,'saved');assert.equal(deliveryNotice(d), '');assert.equal(roomLine({reply:'已出新卡',cards:d.saved.length}), '');assert.notEqual(d.saved[0].id,old);assert.equal(currentVersion(s.cards[id]).number,1);
});
test('重复卡不算新增，返回已有待确认状态；不能按模型数量静默',()=>{
 const s=fresh(),p=make({result:'同一建议'},{sourceIds:['x']});queueProposals(s,scope,[p]);const d=commit(s,[p]);assert.equal(d.saved.length,0);assert.equal(d.outcomes[0].status,'duplicate');const line=deliveryNotice(d,x=>cardName(x));assert.match(line,/已有相同待确认/);assert.match(line,/正文未因此修改/);assert.equal(quietReply('已出修订卡，请确认。',d.saved,[{cardId:id,why:'已有相同卡'}]),'');assert.ok(line);
});
test('并发手改后旧建议不落库，明确回应没有覆盖新版',()=>{
 let s=fresh();const owner={id:'member-03',name:'孙铭泽',visibleUnits:[scope],missionDri:[id]},p=make({result:'过期模型建议'});s=applyAction(s,owner,{type:'revise',cardId:id,baseVersion:1,patch:{result:'人工新成果'}});const d=commit(s,[p]);assert.equal(d.saved.length,0);assert.equal(d.outcomes[0].status,'stale');assert.match(deliveryNotice(d),/没有覆盖新版本/);assert.equal(currentVersion(s.cards[id]).content.result,'人工新成果');
});
test('已在正文的重复建议不新增版本，不能声称再次保存',()=>{
 let s=fresh();const p=make({result:'原成果'}),d=commit(s,[p]);assert.equal(d.saved.length,0);assert.equal(d.outcomes[0].status,'unchanged');assert.match(deliveryNotice(d),/已是这份内容，未新增版本/);assert.equal(s.cards[id].versions.length,1);
});
test('部分交付只计实际保存卡，对未保存项保留准确反馈及独立问答',()=>{
 const s=fresh(),first=make({result:'实际新建议'}),second={cardId:'agents-m2',baseVersion:99,patch:{result:'过期乙'},sourceIds:['why']},d=commit(s,[first,second]);assert.equal(d.saved.length,1);assert.deepEqual(d.outcomes.map(o=>o.status),['saved','stale']);assert.match(deliveryNotice(d,x=>cardName(x)),/M02.*没有覆盖/);
 const cleaned=withoutUnsentCardClaims('已出两张修订卡，请确认。未达成的原因是缺少验收记录。');assert.equal(cleaned,'未达成的原因是缺少验收记录。');const sourceIds=new Set(d.saved.flatMap(p=>p.sourceIds));assert.equal(sourceIds.has('why'),false,'未落库候选不能吞掉提问');assert.ok(roomLine({reply:cleaned,cards:d.saved.length,questions:[{id:'why'}]}));
});
test('独立ref拆成两张按实际2张计数，剩余旧carriedFrom不冒充新交付',()=>{
 const s=fresh();s.cards[id].versions[0].content.facts=[{ref:'a',evidence:'原甲'},{ref:'b',evidence:'原乙'}];const rows=currentVersion(s.cards[id]).content.facts;
 queueProposals(s,scope,[make({facts:rows.map(f=>({...f,evidence:'旧'+f.ref})),result:'其他旧成果'},{originSequence:1})]);
 const planned=[make({facts:rows.map((f,i)=>i?f:{...f,evidence:'最新甲'})},{originSequence:2})],d=commit(s,planned);assert.equal(d.saved.length,1);assert.equal(s.proposals.filter(p=>p.status==='pending').length,2);assert.ok(s.proposals.some(p=>p.carriedFrom));
 const other=fresh();other.cards[id].versions[0].content.facts=rows;const two=commit(other,[make({facts:rows.map(f=>({...f,evidence:'新增'+f.ref}))})]);assert.equal(two.saved.length,2);assert.equal(two.outcomes.length,2);
});
test('已自动应用的实际卡也算交付，保留auto且不代签',()=>{
 let s=fresh(),owner={id:'member-03',name:'孙铭泽',visibleUnits:[scope],missionDri:[id]};s=applyAction(s,owner,{type:'comment',cardId:id,baseVersion:1,block:'result',text:'把成果改为本人新成果'});const p=make({result:'本人新成果'},{sourceIds:[s.comments.at(-1).id]}),ids=new Set((s.proposals||[]).map(p=>p.id));queueProposals(s,scope,[p]);s=applyOwnerAnnotations(s,scope);const d=proposalDelivery(s,ids,scope,[p]);assert.equal(d.saved.length,1);assert.equal(d.saved[0].status,'accepted');assert.equal(d.saved[0].auto,true);assert.equal(currentVersion(s.cards[id]).signatures.length,0);
});
