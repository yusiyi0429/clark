import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {memberActor,sharedProjection} from './shared-projection.mjs';
import {foundationContent,fetchRoundSources,sourceManifest} from './round-sources.mjs';
import {generateRound,validateRound,validateUnit,canonicalOwner} from './round-runner.mjs';
import {layeredGateway,roundKeys} from './layered-mock.mjs';
const task={id:'bf01-m1-t1',unit:'bf01',level:'task',title:'任务',children:[]};
const mission={id:'bf01-m1',unit:'bf01',level:'mission',title:'项目',owner:'白田田',children:[task]};
const po={id:'bf01',level:'po',title:'成果',children:[mission]};
const ceo={id:'ceo',ceo:true,unitDri:['bf01'],missionDri:[]};
const owner={id:'owner',visibleUnits:['bf01'],unitDri:[],missionDri:['bf01-m1']};
test('上级修订只标记下级影响，保留旧签名，核对之前不能确认',()=>{
 let s=createCollaborationState([po]);s=applyAction(s,owner,{type:'confirm',cardId:mission.id,baseVersion:1,slot:'missionDri'});
 s=applyAction(s,ceo,{type:'revise',cardId:po.id,baseVersion:1,patch:{title:'新成果'}});
 assert.equal(currentVersion(s.cards[mission.id]).signatures.length,1);assert.equal(s.cards[mission.id].upstreamChange.version,2);
 assert.throws(()=>applyAction(s,ceo,{type:'confirm',cardId:mission.id,baseVersion:1,slot:'unitDri'}),/核对影响/);
 s=applyAction(s,owner,{type:'acknowledgeImpact',cardId:mission.id,baseVersion:1});assert.equal(s.cards[mission.id].upstreamChange,undefined);
});
test('共享投影仅返回本人私聊，公开批注保留字段与版本',()=>{
 let s=createCollaborationState([po]);s=applyAction(s,owner,{type:'comment',cardId:mission.id,text:'验收标准反馈',block:'checks'});
 s.messages=[{author:'Agent',memberId:'one',channel:'private',text:'secret',createdAt:'2026'},{author:'Agent',memberId:'two',channel:'private',text:'other',createdAt:'2026'}];
 const v=sharedProjection(s,{...owner,id:'one'});assert.equal(v.records['private:one'].length,1);assert.equal(v.records['private:two'],undefined);assert.equal(v.comments[mission.id][0].block,'checks');
});
test('新轮成员职责按新 Mission owner 推导，不继承旧编号派工',()=>{const s=createCollaborationState([po]);s.round={};const id=Object.entries((awaitProfiles())).find(([,p])=>p.name==='白田田')[0];assert.deepEqual(memberActor(id,s).missionDri,['bf01-m1']);});
import {memberProfiles} from './member-profiles.mjs';
function awaitProfiles(){return memberProfiles;}
test('生成结构不能把数字Activity或空Task当成完成；候选后缀不冒充新姓名',()=>{assert.equal(canonicalOwner('白田田（候选）'),'白田田');assert.throws(()=>canonicalOwner('不是白田田'));const fields={title:'成果',result:'结果',checks:['证据'],owner:'白田田'};assert.throws(()=>validateUnit({...fields,key:'bf01',missions:[{...fields,tasks:[]}]}),/Task/);assert.throws(()=>validateUnit({...fields,key:'bf01',missions:[{...fields,tasks:[{...fields,activities:[0]}]}]}),/卡片结构/);});
test('新轮读取十五份基础材料，排除结果文档，未知标题 fail closed',async()=>{
 assert.equal(sourceManifest.length,15);assert.ok(!sourceManifest.some(s=>s[2]==='Fgz5wQSbpiLuCCkOdf6cQXvNneI'));
 const xml='<h1>9月复盘</h1><p>事实</p><h1>10月PO</h1><p>旧答案</p><h1>长期目标</h1><p>长期结果</p>';
 assert.ok(!foundationContent(xml,'bf01').includes('旧答案'));assert.throws(()=>foundationContent('<p>新结构</p>','bf01'));
 const input=await fetchRoundSources({fetchDocument:async()=>({document_id:'d',revision_id:1,content:xml})});assert.equal(input.sources.length,15);assert.equal(input.capacity.workCalendar,null);assert.equal(input.capacity.hoursPerWorkday,null);assert.equal(input.capacity.otherWorkHours,null);
});
test('新轮逐层生成：PO、Mission 各十个领域并行，Task 按 Mission 并行，交叉验证无问题即进入下一层，Task 由总校验统一检查',async()=>{
 const ownerByUnit=key=>Object.values(memberProfiles).find(p=>p.unitDri.includes(key)).name;
 const make=key=>{const card={title:'新成果',result:'候选结果',checks:['证据'],owner:ownerByUnit(key)};return {...card,key,name:key,missions:[{...card,tasks:[{...card,activities:[]}]}]};};
 const stages=[];const v=await generateRound({gateway:layeredGateway(make,{onCall:q=>stages.push(q.stage)}),rules:'quality rules',fetchSources:async()=>({sources:[],capacity:{hoursPerWorkday:8},retrievedAt:'test'})});
 assert.equal(v.units.length,10);assert.equal(v.counts.task,10);assert.equal(v.status,'candidate-needs-review');assert.throws(()=>validateRound([]));
 const count=s=>stages.filter(x=>x===s).length;
 for(const layer of ['po','mission','task'])assert.equal(count(layer+'-generate'),10);
 assert.deepEqual(stages.filter(s=>s.endsWith('-check')),['po-check','mission-check','final-check']);
 assert.ok(stages.indexOf('po-check')<stages.indexOf('mission-generate')&&stages.indexOf('mission-check')<stages.indexOf('task-generate'));
 assert.deepEqual(v.audit.iterations.map(x=>x.layer),['po','mission','final','format']);
});
test('失败续跑沿用本轮材料和已完成的层，不重新抓取也不借旧轮答案',async()=>{
 const make=key=>{const owner=Object.values(memberProfiles).find(p=>p.unitDri.includes(key)).name;const card={title:'本轮结果',result:'待核对结果',checks:['证据'],owner};return {...card,key,name:key,missions:[{...card,tasks:[{...card,activities:[]}]}]};};
 const po=k=>{const {missions,...rest}=make(k);return {po:rest,upstream:[],sharedEvents:[]};};
 const withMissions=k=>({...po(k),missions:make(k).missions.map(({tasks,...m})=>m)});
 const units=f=>Object.fromEntries(roundKeys.map(k=>[k,f(k)]));
 const layerState={po:{units:units(po),rounds:1,remaining:[],done:true},mission:{units:units(withMissions),rounds:1,remaining:[],done:true},task:{units:Object.fromEntries(roundKeys.slice(0,9).map(k=>[k,{...withMissions(k),missions:make(k).missions}])),rounds:0,remaining:[]}};
 const stages=[];const result=await generateRound({rules:'rules',resume:{input:{sources:[],capacity:{hoursPerWorkday:8}},layerState},fetchSources:()=>{throw Error('不应重新抓取');},gateway:layeredGateway(make,{onCall:q=>stages.push(q.stage+':'+(q.key||'all'))})});
 assert.deepEqual(stages,['task-generate:finance','final-check:all']);assert.equal(result.units.length,10);
});
test('模型结构化验收和依赖保留原始出处，呈现为文档字段而非丢失',()=>{
 const card={title:'成果',result:'结果',owner:'白田田',checks:[{evidence:'记录',criterion:'有负责人'}],dependencies:{input:'已核对资料'},time:null};const u={...card,key:'bf01',missions:[{...card,tasks:[{...card,activities:[]}]}]};validateUnit(u);
 assert.match(u.missions[0].checks[0],/有负责人/);assert.match(u.dependencies,/已核对资料/);assert.deepEqual(u.generatedFieldSources.dependencies,{input:'已核对资料'});assert.equal(u.time,undefined);
});
test('带候选标记的负责人仍归入本人目录',async()=>{
 const {ownerName}=await import('./shared-projection.mjs');
 for(const v of ['刘明华','刘明华（候选）','待确认候选：刘明华','候选：刘明华'])assert.equal(ownerName(v),'刘明华');
 assert.equal(ownerName('不是名单里的人'),'不是名单里的人');
});
