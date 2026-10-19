import {test} from 'node:test';
import assert from 'node:assert/strict';
import {trimTrailingPunct,planSummary} from './reader-view.mjs';
import {cardIssues} from './card-issues.mjs';
test('暂缓项标题去掉结尾标点，避免“。：”',()=>{
 assert.equal(trimTrailingPunct('四方法可在不同企业复制。'),'四方法可在不同企业复制');
 assert.equal(trimTrailingPunct('无标点'),'无标点');
});
test('下级成果摘要取第一句，超长在逗号处截断',()=>{
 assert.deepEqual(planSummary('CEO及相关DRI认可同版角色；孙铭泽据此调整迭代。'),{text:'CEO及相关DRI认可同版角色',truncated:true});
 assert.deepEqual(planSummary('只有一句。'),{text:'只有一句',truncated:false});
 const long=planSummary('M1真实判断进入M2责任拆解，M3试点Mission实际执行且成果获验收，MF据真实偏差推动纠偏并验证后续变化');
 assert.ok(long.truncated&&long.text.endsWith('…')&&[...long.text].length<=51);
 assert.equal(long.text,'M1真实判断进入M2责任拆解，M3试点Mission实际执行且成果获验收…');
});
test('检查问题按单位和卡片标题挂到对应卡片，并能汇总下级',()=>{
 const units=[{id:'bf',key:'bf01',level:'po',title:'客户经营协同',children:[{id:'bf-m1',level:'mission',title:'规则采纳',children:[{id:'bf-m1-t1',level:'task',title:'联合通关',children:[]}]}]}];
 const audit={issues:[{unitKey:'bf01',cardTitle:'联合通关',problem:'a'},{unitKey:'bf01',cardTitle:'客户经营协同',problem:'b'},{unitKey:'bf01',cardTitle:'不存在',problem:'c'},{unitKey:'bf01',cardTitle:'联合通关',fieldPath:'x',problem:'字数'}]};
 const map=cardIssues(units,audit);
 assert.deepEqual(map.own('bf-m1-t1').map(x=>x.problem),['a']);
 // A title that no longer matches still lands on its unit's PO rather than disappearing.
 assert.deepEqual(map.own('bf').map(x=>x.problem),['b','c']);
 assert.equal(map.subtree(units[0]).length,3);
 assert.equal(map.subtree(units[0].children[0]).length,1);
});
import {catalogGroups} from './document-navigation.mjs';
test('首页目录：成员先看自己负责的领域，再看 Mission；CEO 分战场和能力域',()=>{
 const list=[{id:'m',level:'mission'},{id:'d',level:'po',name:'Domain 2 Method'},{id:'b',level:'po',name:'Battlefield 1'}];
 assert.deepEqual(catalogGroups(list,{member:true}).map(g=>[g.title,g.items.map(n=>n.id)]),[['我负责的领域',['d','b']],['我负责的 Mission',['m']]]);
 assert.deepEqual(catalogGroups(list.slice(1),{member:true,ceo:true}).map(g=>[g.title,g.items.map(n=>n.id)]),[['战场',['b']],['能力域',['d']]]);
 assert.deepEqual(catalogGroups([{id:'m',level:'mission'}],{member:true}).map(g=>g.title),['我负责的 Mission']);
});
test('下级问题显示从当前卡到问题卡的层级路径',()=>{
 const t={id:'t',level:'task',title:'T',children:[]},m={id:'m',level:'mission',title:'M',children:[t]},po={id:'p',key:'k',level:'po',title:'P',children:[m]};
 const map=cardIssues([po],{issues:[]});
 assert.deepEqual(map.pathFrom(po,t).map(n=>n.id),['m','t']);
 assert.deepEqual(map.pathFrom(m,t).map(n=>n.id),['t']);
});
import {nodePath,levelTone} from './document-navigation.mjs';
import {cardFields} from './document-template.mjs';
test('层级路径和层级配色',()=>{
 const t={id:'t',level:'task',children:[]},m={id:'m',level:'mission',children:[t]},po={id:'p',level:'po',name:'Domain 3 Agents',children:[m]};
 assert.deepEqual(nodePath([po],'t').map(n=>n.id),['p','m','t']);
 assert.deepEqual(nodePath([po],'x'),[]);
 assert.deepEqual([po,{level:'po',name:'Battlefield 1'},m,t].map(levelTone),['domain','battlefield','mission','task']);
});
test('各层卡片默认字段顺序一致：成果 → 验收标准 → 责任边界',()=>{
 for(const level of ['po','mission','task'])assert.deepEqual(cardFields[level].key.slice(0,3).map(([,label])=>label),['成果','验收标准','责任边界']);
 assert.equal(cardFields.po.more[0][1],'存在必要性');assert.equal(cardFields.mission.more[0][1],'存在必要性');assert.equal(cardFields.task.more[0][1],'存在必要性');
});
import {planTrack,shortLabel} from './plan-track.mjs';
test('Plan 时间线：日期落在对应周列，节点按时间连成路径，每行最多写两个节点名',()=>{
 const U=(m,d)=>Date.UTC(2026,m-1,d),weeks=[[1,7],[8,14],[15,21],[22,28],[29,31]].map(([a,b])=>({from:U(10,a),to:U(10,b)}));
 const t=planTrack(weeks,[U(10,15),U(10,31)],[{at:U(10,31),label:'复核'},{at:U(10,16),label:'核定'},{at:U(10,21),label:'可用'}]);
 assert.equal(t.bar.left,40);assert.equal(t.bar.right,100);
 assert.deepEqual(t.points.map(p=>p.label),['核定','可用','复核']);
 // Only the final result and one far-enough earlier node carry names.
 assert.deepEqual(t.points.map(p=>p.labeled),[true,false,true]);
 assert.deepEqual(planTrack(weeks,null,[{at:U(10,29),label:'a'},{at:U(10,30),label:'b'}]).points.map(p=>p.labeled),[false,true]);
 assert.equal(t.points[2].last,true);assert.equal(t.path.left,t.points[0].pct);
 assert.ok(t.points[1].pct<60&&t.points[1].pct>40);
 assert.equal(shortLabel('Mission 01'),'M01');assert.equal(shortLabel('Task 03'),'T03');assert.equal(shortLabel('Activity 02'),'A02');
});
import {dependencyName,taskDependencies} from './plan-deps.mjs';
test('前置依赖：识别同 Mission 的前置 Task，外部依赖只计数，只画最近的一个',()=>{
 assert.deepEqual(dependencyName('「真实工作承载」：10/16 可用即可开始'),{name:'真实工作承载',prefixed:false});
 assert.deepEqual(dependencyName('Agents「多人经营协同」：陈溪南10/16交'),{name:'多人经营协同',prefixed:true});
 assert.deepEqual(dependencyName('**基线：**「共同基线实用」已认可'),{name:'共同基线实用',prefixed:false});
 assert.deepEqual(dependencyName('样本与评分基线：10/16首批'),{name:'样本与评分基线',prefixed:false});
 const t1={id:'t1',title:'真实工作承载',time:'2026-10-15—2026-10-19'},t2={id:'t2',title:'正式路径贯通',time:'2026-10-15—2026-10-21'};
 const t3={id:'t3',title:'CEO议题实用',time:'2026-10-20—2026-10-23',dependsOn:['「真实工作承载」：可准备','「正式路径贯通」：等放行','Agents「评测驱动版本放行」：门禁','CEO与DRI真实使用：孙铭泽提供']};
 const r=taskDependencies(t3,[t1,t2,t3]);
 assert.deepEqual(r.internal.map(n=>n.id),['t1','t2']);assert.equal(r.external,2);assert.equal(r.nearest.id,'t2');
});
import {todoItems,unreadCount} from './todo.mjs';
test('待我处理：修订建议、上级调整、对方已签、@我、新批注，按紧急程度排序',()=>{
 const units=[{id:'eo',level:'po',owner:'刘人豪',children:[{id:'eo-m2',unit:'eo',level:'mission',owner:'于斯一',children:[{id:'eo-m2-t1',unit:'eo',level:'task',children:[]},{id:'eo-m2-t2',unit:'eo',level:'task',children:[]}]}]}];
 const drafts={'eo-m2':{version:2,signatures:[{slot:'unitDri'}]},'eo-m2-t1':{upstreamChange:{version:2}},'eo-m2-t2':{upstreamChange:{version:2}}};
 const records={'group:eo':[{kind:'revision-proposal',status:'pending',canAccept:true,cardId:'eo-m2',id:'p1',createdAt:'2026-10-16T03:00:00Z'},{author:'刘人豪',text:'@于斯一 看一下',id:'m1',createdAt:'2026-10-16T03:01:00Z'},{author:'刘人豪',text:'旧消息 @于斯一',id:'m0',createdAt:'2026-10-16T01:00:00Z'}]};
 const comments={'eo-m2':[{author:'刘人豪',createdAt:'2026-10-16T03:02:00Z'},{author:'于斯一',createdAt:'2026-10-16T03:03:00Z'}]};
 const items=todoItems({units,drafts,records,comments,profile:{unitDri:[],missions:['eo-m2']},name:'于斯一',seen:{'group:eo':Date.parse('2026-10-16T02:00:00Z')}});
 assert.deepEqual(items.map(i=>i.kind),['proposal','upstream','sign','mention','comment']);
 assert.equal(items[1].count,2);assert.equal(items[2].otherSigned,true);assert.equal(items[4].count,1);
 assert.equal(unreadCount(records['group:eo'],'于斯一',Date.parse('2026-10-16T02:00:00Z')),2);
});
import {proposalRows,stripMarks} from './proposal-diff.mjs';
test('修订卡只突出改动的条目，去掉加粗标记',()=>{
 const rows=proposalRows(['**甲：**一','**乙：**二'],['**甲：**一','**乙：**三','**丙：**四']);
 assert.deepEqual(rows.map(r=>r.kind),['same','changed','added']);
 assert.equal(stripMarks(rows[1].after),'乙：三');
 assert.deepEqual(proposalRows('旧句子','新句子').map(r=>r.kind),['changed']);
});
import {disagrees,agrees,declinesChange} from './stance.mjs';
test('立场判断：否定和提问不算反对，“不需要改”不算修改请求',()=>{
 for(const t of ['我不反对','大家有不同意见吗？','没有异议，按这个来'])assert.equal(disagrees(t),false,t);
 for(const t of ['我不同意改成15个','这个方案不能接受'])assert.equal(disagrees(t),true,t);
 assert.equal(agrees('同意刘人豪的分两批'),true);assert.equal(agrees('我不同意'),false);assert.equal(agrees('我不反对'),true);
 assert.equal(declinesChange('这里不需要改'),true);assert.equal(declinesChange('要不要明确一下？'),true);assert.equal(declinesChange('建议改成15个'),false);
});
import {inlineChange} from './proposal-diff.mjs';
test('一句话里只标出改动的几个字',()=>{
 assert.deepEqual(inlineChange('正式profile承载同一真实Mission','经CEO批准的正式profile承载同一真实Mission'),{head:'',removed:'',added:'经CEO批准的',tail:'正式profile承载同一真实Mission'});
 assert.equal(inlineChange('30真实案例达标','10/24先交15个，10/30补齐30个真实案例达标').added,'10/24先交15个，10/30补齐30个');
});
import {recordTopic} from './topic-lifecycle.mjs';
test('纪要：群里直接说的话并入正在进行的话题，字段批注才开新话题',()=>{
 const t=[];const at=n=>`2026-10-16T06:4${n}:00Z`;
 recordTopic(t,{id:'c1',channel:'group',author:'刘明华',text:'灯塔不考虑经济性',cardId:'bf01',version:1,block:'checks',createdAt:at(1)});
 recordTopic(t,{id:'m1',channel:'group',author:'孙铭泽',text:'需要放开资源',cardId:'bf01',general:true,createdAt:at(2)});
 recordTopic(t,{id:'m2',channel:'group',author:'陈溪南',text:'成本记录要保留',cardId:'bf01',general:true,createdAt:at(3)});
 assert.equal(t.length,1);assert.equal(t[0].status,'discussing');assert.deepEqual(t[0].sourceIds,['c1','m1','m2']);
 recordTopic(t,{id:'c2',channel:'group',author:'刘明华',text:'拿掉 CoAgent',cardId:'bf01',version:1,block:'result',createdAt:at(4)});
 assert.equal(t.length,2);assert.equal(t[1].status,'pending');
});
test('改动标注按整个日期或数字标出',()=>{
 const c=inlineChange('10/22 正式部署首用','10/24 正式部署首用');
 assert.equal(c.removed,'10/22');assert.equal(c.added,'10/24');assert.equal(c.tail,' 正式部署首用');
});
import {changeSummary} from './proposal-diff.mjs';
test('修订卡一句话概括：每个字段改了几条',()=>{
 assert.equal(changeSummary(['a','b'],['a','c','d']),'改 1 条、增 1 条');
 assert.equal(changeSummary('旧成果','新成果'),'改写');
});
test('系统通知里的 @ 不重复算作待处理',()=>{
 const items=todoItems({units:[],records:{'group:eo':[{kind:'notice',author:'Nexus',text:'请 @刘人豪 确认新版本',createdAt:'2026-10-16T03:00:00Z'}]},profile:{unitDri:[],missions:[]},name:'刘人豪'});
 assert.equal(items.length,0);
});
import {privateAgentContext} from './private-agent-context.mjs';
import {createCollaborationState,applyAction as act} from './governance.mjs';
test('私人 Agent 拿到全局确认进度，不受当前页面限制',()=>{
 let s=createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',children:[{id:'bf01-m2',unit:'bf01',level:'mission',title:'正式部署',owner:'孙铭泽',children:[]},{id:'bf01-m3',unit:'bf01',level:'mission',title:'管理者承接',owner:'陈溪南',children:[]}]}]);
 const ceo={id:'member-01',ceo:true,unitDri:['bf01'],missionDri:[],visibleUnits:['bf01']},sun={id:'member-03',unitDri:[],missionDri:['bf01-m2'],visibleUnits:['bf01']},chen={id:'member-04',unitDri:[],missionDri:['bf01-m3'],visibleUnits:['bf01']};
 s=act(s,sun,{type:'confirm',cardId:'bf01-m2',slot:'missionDri',baseVersion:1});s=act(s,ceo,{type:'confirm',cardId:'bf01-m2',slot:'unitDri',baseVersion:1});
 s=act(s,chen,{type:'confirm',cardId:'bf01-m3',slot:'missionDri',baseVersion:1});
 const c=privateAgentContext(s,ceo,{});
 assert.deepEqual(c.progress.confirmedByMe.map(x=>x.title),['正式部署']);
 assert.deepEqual(c.progress.waitingForMe.map(x=>[x.title,x.otherSideConfirmed]),[['灯塔',false],['管理者承接',true]]);
 assert.equal(c.progress.counts.mission['已确认'],1);assert.match(c.progress.recentConsensus[0].text,/达成共识/);
});
import {validateNexusResult,cardAliases,wholeSentences} from './nexus-policy.mjs';
import {mergeTopics} from './nexus-memory.mjs';
import {verifiedIntervention} from './nexus-next-step.mjs';
test('Nexus：认得 M03 这类简称；列表字段必须给列表；已握手的卡不主动出建议',()=>{
 assert.deepEqual(cardAliases('bf01-m3'),['M03','Mission 03','M3']);assert.deepEqual(cardAliases('bf01-m3-t2'),['T02','Task 02','T2']);
 const cards=[{id:'bf01',level:'po',title:'灯塔',version:1},{id:'bf01-m3',level:'mission',title:'管理者承接经营责任并跨轮纠偏',aliases:cardAliases('bf01-m3'),version:2,result:'旧成果',dependencies:['甲','乙']},{id:'bf01-m2',level:'mission',title:'正式部署',aliases:cardAliases('bf01-m2'),version:2,status:'已确认',result:'r'}];
 const ask={id:'a',author:'陈溪南',kind:'chat',text:'请把灯塔 M03 的成果改成经CEO/DRI Agent承接'};
 let r=validateNexusResult({topics:[],proposals:[{cardId:'bf01-m3',baseVersion:2,basis:'request',sourceIds:['a'],patch:{result:'新成果'}}]},{cards,evidence:[ask]});
 assert.equal(r.proposals.length,1);
 r=validateNexusResult({topics:[],proposals:[{cardId:'bf01-m3',baseVersion:2,basis:'request',sourceIds:['a'],patch:{dependencies:'一句话'}}]},{cards,evidence:[ask]});
 assert.equal(r.proposals.length,0);
 const ask2={id:'b',author:'孙铭泽',kind:'chat',text:'建议把 M02 的成果改一下'};
 r=validateNexusResult({topics:[],proposals:[{cardId:'bf01-m2',baseVersion:2,basis:'request',sourceIds:['b'],patch:{result:'x'}}]},{cards,evidence:[ask2]});
 assert.equal(r.proposals.length,0);
 r=validateNexusResult({topics:[],proposals:[{cardId:'bf01-m2',baseVersion:2,basis:'request',sourceIds:['c'],patch:{result:'x'}}]},{cards,evidence:[{...ask2,id:'c',text:'@Nexus 建议把 M02 的成果改一下'}]});
 assert.equal(r.proposals.length,1);
});
test('Nexus：字段批注加两人明确同意，算共识',()=>{
 const cards=[{id:'eo',level:'po',title:'E&O',version:1},{id:'eo-m2',level:'mission',title:'受控上下文复用',version:1}];
 const ev=[{id:'c',author:'于斯一',kind:'document-comment',text:'建议改成15个',context:{selection:{id:'eo-m2',version:1},block:'checks'}},{id:'m1',author:'刘人豪',kind:'chat',text:'可以分两批：10/24先交15个，10/30补齐30个。',context:{selection:{id:'eo',version:1}}},{id:'m2',author:'于斯一',kind:'chat',text:'同意刘人豪的分两批。',context:null}];
 const r=validateNexusResult({topics:[{title:'案例数',status:'agreement',sourceIds:['c','m1','m2'],quotes:ev.map(e=>({id:e.id,text:e.text}))}],proposals:[]},{cards,evidence:ev});
 assert.equal(r.topics[0].status,'agreement');
});
test('纪要：新话题只在覆盖旧话题开头时才合并，未决话题不会被吞',()=>{
 const old=[{id:'x',title:'投入上限与成本口径',status:'discussing',sourceIds:['c1','m1','m2'],quotes:[]}];
 const next=mergeTopics(old,[{title:'首用节点与资源依赖',status:'discussing',sourceIds:['m1','m5'],quotes:[]}]);
 assert.deepEqual(next.map(t=>t.title).sort(),['投入上限与成本口径','首用节点与资源依赖'].sort());
});
test('撮合：两人立场冲突才发言；回答不断在半句',()=>{
 const card={id:'agents-m1',title:'CEO与DRI跨轮使用',version:1};const refersTo=()=>true;
 const ev=[{id:'a',author:'刘明华',text:'至少5轮、20次以上。'},{id:'b',author:'孙铭泽',text:'5轮做不完，我不同意10/30前完成。'}];
 const v={interventionType:'mediation',interventionCardId:card.id,interventionVersion:1,interventionSourceIds:['a','b'],interventionRecipient:'刘明华',interventionImpact:'刘明华要5轮20次，孙铭泽认为10/30前做不完。',interventionQuestion:'建议10/30前3轮、20次，第4、5轮放到11月第一周。',interventionKey:'k'};
 const step=verifiedIntervention(v,{cards:[card],evidence:ev,refersTo});
 assert.ok(step&&!step.reply.includes('。。'));
 assert.equal(verifiedIntervention(v,{cards:[card],evidence:ev.map(e=>({...e,author:'刘明华',text:'都可以'})),refersTo}),null);
 assert.equal(wholeSentences('第一句话。第二句话很长很长。',8),'第一句话。');
});
import {applyOwnerAnnotations,queueProposals as queue} from './nexus-memory.mjs';
test('负责人在自己卡上的批注：Nexus 直接修改并在群里通知；别人批注仍等负责人确认',()=>{
 const base=()=>createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',checks:['**经济性：**核投入'],children:[]}]);
 const ceo={id:'member-01',ceo:true,unitDri:['bf01'],missionDri:[],visibleUnits:['bf01']};
 let s=act(base(),ceo,{type:'comment',cardId:'bf01',block:'checks',text:'灯塔不考虑经济性，删掉这条'});
 s=applyOwnerAnnotations(queue(s,'bf01',[{cardId:'bf01',baseVersion:1,sourceIds:[s.comments[0].id],patch:{checks:['**范式：**改为不考虑经济性']},reason:'r'}]),'bf01');
 assert.equal(s.proposals[0].status,'accepted');assert.equal(s.proposals[0].auto,true);
 assert.match(s.messages.filter(m=>m.kind==='notice').at(-1).text,/Nexus 已按 刘明华 的批注修改「灯塔」，已更新到 v2/);
 const other={id:'member-04',unitDri:[],missionDri:[],visibleUnits:['bf01']};
 let t=act(base(),other,{type:'comment',cardId:'bf01',block:'checks',text:'建议删掉经济性'});
 t=applyOwnerAnnotations(queue(t,'bf01',[{cardId:'bf01',baseVersion:1,sourceIds:[t.comments[0].id],patch:{checks:['x']},reason:'r'}]),'bf01');
 assert.equal(t.proposals[0].status,'pending');
});
import {progressQuestion} from './nexus-participation.mjs';
test('进度问题不用 @ 也由 Nexus 回答；点名某人的不抢答',()=>{
 assert.equal(progressQuestion({text:'改完了吗？'}),true);assert.equal(progressQuestion({text:'还差谁没确认'}),true);
 assert.equal(progressQuestion({text:'@孙铭泽 改完了吗'}),false);assert.equal(progressQuestion({text:'@Nexus 进度怎样'}),true);
 assert.equal(progressQuestion({text:'我同意分两批'}),false);
});
import {roundSteps,roundLine,roundPill,gapSummary,shortTime} from './round-steps.mjs';
test('新一轮状态卡：步骤条按阶段标出已完成、当前和中断位置',()=>{
 const states=job=>roundSteps(job).map(s=>s.state).join(' ');
 assert.equal(states({status:'running',stage:'准备实时读取本体并核对来源'}),'current todo todo todo todo');
 assert.equal(states({status:'running',stage:'Mission 层：并行生成',done:6,total:10}),'done done current todo todo');
 assert.equal(roundSteps({status:'running',stage:'Mission 层：并行生成',done:6,total:10})[2].count,'6/10');
 assert.equal(states({status:'running',stage:'Task 层完成'}),'done done done done current');
 assert.equal(states({status:'running',stage:'总校验：交叉验证第 1 轮',done:0,total:1}),'done done done done current');
 assert.equal(roundSteps({status:'running',stage:'总校验：交叉验证第 1 轮',done:0,total:1})[4].count,'');
 assert.equal(states({status:'failed',stage:'Mission 层：并行生成',canResume:true}),'done done stopped todo todo');
 assert.equal(states({status:'ready',stage:'精简：第 1 遍'}),'done done done done done');
 assert.equal(states(null),'todo todo todo todo todo');
});
test('新一轮状态卡：一句话说明停在哪、能否续跑',()=>{
 assert.equal(roundLine({status:'failed',stage:'Mission 层：并行生成',error:'连接被中断。',canResume:true},17),'停在 Mission 层：连接被中断。续跑沿用这次读到的资料，已完成的部分不重做。');
 assert.equal(roundLine({status:'failed',stage:'准备实时读取本体并核对来源',error:'来源变化',canResume:false},17),'停在读取本体：来源变化。这次不能续跑，只能重新读取本体并生成。');
 assert.equal(roundLine({status:'running',stage:'Task 层：并行生成',done:3,total:12},17),'正在 Task 层：并行生成（3/12）。期间仍显示第 17 轮，可以关掉这个窗口。');
 assert.equal(roundLine({status:'ready',counts:{po:10,mission:28,task:60}},17),'已生成 10 PO · 28 Mission · 60 Task，还没载入。载入后画布切到新一轮，旧轮保留。');
 assert.deepEqual(roundPill({status:'failed',canResume:true}),['已中断 · 可续跑','is-failed']);
 assert.deepEqual(roundPill(null),['未开始','is-idle']);
});
test('新一轮状态卡：资料缺口同一原因只写一次，时间显示到分钟',()=>{
 const reason='只有关联资料推断，没有独立推进记录；不能冒充独立成果';
 assert.equal(gapSummary([{unit:'rearch',reason},{unit:'bf03',reason}]),`2 处资料缺口：rearch、bf03 ${reason}。`);
 assert.match(shortTime('2026-10-16T03:44:35.814Z'),/^2026-10-16 \d\d:44$/);
 assert.equal(shortTime(''),'');
});
import {gateEntries,splitBoundary,shortEffort,v3Layout,planColumns,responseTone,supplyRows,weekdaysIn,unitShortName} from './v3-display.mjs';
test('3.0 显示：关口线解析日期、关口名和支撑人，解析不了就不画',()=>{
 const g=gateEntries(['**内部首验（10/14）：**白田田、孙铭泽支撑。真实议题可供首次体验。','**持续运行（10/30）：**四条结果线共同支撑。两周记录齐全。']);
 assert.deepEqual(g.map(x=>[x.date,x.name,x.support]),[['10/14','内部首验','白田田、孙铭泽支撑'],['10/30','持续运行','四条结果线共同支撑']]);
 assert.equal(gateEntries(['G1 旧格式路径','G2 另一段']),null);
 assert.equal(gateEntries(['**内部首验（10/14）：**白田田支撑。']),null);
});
test('3.0 显示：Task 投入和停止条件从责任边界里拆出，Plan 表只显示人日',()=>{
 const b=splitBoundary({boundary:['**投入：**约2人日，含筹备和返工。','**停止：**授权不明时暂停并报刘明华。','**不含：**客户侧部署']});
 assert.equal(b.effort,'约2人日，含筹备和返工。');assert.equal(b.stop,'授权不明时暂停并报刘明华。');assert.deepEqual(b.rest,['**不含：**客户侧部署']);
 assert.equal(shortEffort(b.effort),'约 2 人日');assert.equal(shortEffort('3–4 人日'),'3–4 人日');
 const t=v3Layout({level:'task',boundary:['**投入：**约2人日。']});
 assert.deepEqual(t.key.map(([f])=>f),['result','checks','effort','stop']);
 assert.equal(v3Layout({level:'task',boundary:['只负责内部']}),null);
});
test('3.0 显示：PO 有单元计划才换布局，风险从约束与依赖里分出来',()=>{
 const po={level:'po',plan:{risks:['**客户窗口：**无授权时协调']},logic:['**首验（10/14）：**甲支撑。'],dependencies:['**客户材料：**10/12核对','**客户窗口：**无授权时协调'],tradeoff:['**范围：**先跑授权事项'],why:['**贡献：**灯塔检验主线'],expectedProgress:'灯塔检验主线'};
 const l=v3Layout(po);
 assert.deepEqual(l.key.map(([f,label])=>`${f}:${label}`),['result:成果','logic:里程碑','checks:验收标准','risks:风险']);
 assert.deepEqual(l.more,[['expectedProgress','LTO 贡献']]);
 assert.deepEqual(planColumns(po).map(([f,,rows])=>[f,rows.length]),[['tradeoff',1],['dependencies',1],['risks',1]]);
 assert.equal(v3Layout({level:'po',logic:['G1']}),null);
 // Mission mirrors the PO: 风险 up front; older rounds kept risks in 约束与依赖 (陈溪南 2026-10-19).
 {const m=v3Layout({level:'mission',tier:'P1',result:'r',checks:['c'],risks:['**签发：**晚了先用9月'],dependencies:['**签发：**晚了先用9月','**E&O：**10/21 交读取']});assert.deepEqual(m.key.map(([f])=>f),['result','checks','risks']);assert.deepEqual(m.node.dependencies,['**E&O：**10/21 交读取']);
  const old=v3Layout({level:'mission',tier:'P1',dependencies:['**风险：**x']});assert.deepEqual(old.node.risks,['**风险：**x']);assert.deepEqual(old.node.dependencies,[]);}
});
test('3.0 显示：跨域需求只认被要的那个领域的回应',()=>{
 const units=[{key:'bf01',demands:[{id:'bf01-D1',to:'method',what:'场景规格',by:'2026-10-13'},{id:'bf01-D2',to:'eo',what:'读写接口'}]},
  {key:'method',responses:[{demandId:'bf01-D1',response:'部分接',missionTitle:'四方法有效',note:'质量标准需补充'}]},
  {key:'eo',responses:[]},{key:'tokenhub',responses:[{demandId:'bf01-D2',response:'接'}]}];
 const bf=supplyRows(units,units[0]);
 assert.deepEqual(bf.asked.map(r=>[r.to,r.label,r.by]),[['method','部分接','10/13'],['eo','未回应','']]);
 assert.deepEqual(supplyRows(units,units[1]).received.map(r=>[r.from,r.missionTitle]),[['bf01','四方法有效']]);
 assert.deepEqual(['接','部分接','接不了',''].map(x=>responseTone(x)[0]),['ok','partial','no','none']);
});
test('3.0 显示：人日负荷的参考线是该月周一至周五天数',()=>{
 assert.equal(weekdaysIn('2026-10-01—2026-10-31'),22);
 assert.equal(weekdaysIn('待定'),0);
});
test('3.0 显示：跨域供需里的领域名取短名',()=>{
 assert.deepEqual(['Domain Finance, Compliance & Operations','Domain Talent & Organization','Domain E&O','Battlefield 灯塔项目'].map(name=>unitShortName({name})),['Finance','Talent','E&O','灯塔项目']);
});
import {workloadRows} from './v3-display.mjs';
test('3.0 显示：人日竖线先用程序算的容量，个人记录优先，没有才退回本月工作日',()=>{
 const units=[{time:'2026-10-01—2026-10-31'}],personDays=[{name:'唐巨杰',personDays:38},{name:'秦梦怡',personDays:17,capacityDays:20},{name:'陈溪南',personDays:10.5}];
 const fallback=workloadRows({personDays},units);
 assert.deepEqual(fallback.list.map(r=>[r.limit,r.over]),[[22,true],[20,false],[22,false]]);
 assert.equal(fallback.note,'竖线是本月周一至周五 22 天，未扣节假日');
 const measured=workloadRows({personDays,capacity:{days:12.8,basis:'10/09 起工作日，每天 8 小时'}},units);
 assert.deepEqual(measured.list.map(r=>[r.limit,r.over]),[[12.8,true],[20,false],[12.8,false]]);
 assert.equal(measured.note,'竖线是可用容量 12.8 人日（10/09 起工作日，每天 8 小时）');
 assert.equal(workloadRows({},units),null);
});
import {modelLine,skillLine} from './entry-fields.mjs';
test('首页技能版本写本轮内容的版本和生成时间、最新可用注明重开后使用；当前模型总写推理强度',()=>{
 assert.equal(skillLine({skill:'2.0.7',availableSkill:'3.0.6',generationTiming:{finishedAt:'2026-10-16T08:21:58.957Z'}}),'本轮内容 2.0.7（10/16 16:21 生成）· 最新可用 3.0.6（重开后使用）');
 assert.equal(skillLine({skill:'3.0.3',availableSkill:'3.0.3'}),'本轮内容 3.0.3（生成时间未记录）· 最新可用 3.0.3（重开后使用）');
 const now={modelReady:true,modelStatus:{provider:'TokenHub',model:'wangsu/gpt-6.1-sol'}};
 assert.equal(modelLine({...now,generationModel:{model:'wangsu/gpt-6.1-sol',reasoningEffort:'high'}}),'TokenHub · wangsu/gpt-6.1-sol · 推理强度 high');
 assert.equal(modelLine({...now,generationModel:{model:null,reasoningEffort:'high'}}),'TokenHub · wangsu/gpt-6.1-sol · 推理强度 high');
 assert.equal(modelLine({...now,generationModel:{model:'gpt-5',reasoningEffort:'max'}}),'本轮用 gpt-5 · 推理强度 max · 现在 TokenHub · wangsu/gpt-6.1-sol');
 assert.equal(modelLine({...now}),'TokenHub · wangsu/gpt-6.1-sol · 推理强度 未记录');
 assert.equal(modelLine({modelReady:false}),'待配置');
});
import {unitCounts,confirmationLabel,shortDate} from './entry-fields.mjs';
test('首页数据来源：单元行写已读数，有不全或缺才写；确认状态和日期写成中文短格式',()=>{
 assert.deepEqual(unitCounts({read:6,partial:0,missing:0}),[['read','已读 6']]);
 assert.deepEqual(unitCounts({read:4,partial:1,missing:1}),[['read','已读 4'],['partial','不全 1'],['missing','缺 1']]);
 assert.deepEqual(['draft','unconfirmed','user-selected',null].map(confirmationLabel),['草稿','未确认','人工选定','未标注']);
 assert.equal(shortDate('2026-10-09T23:59:59+08:00'),'10/09');
});
import {clampNameCol} from './plan-track.mjs';
test('甘特图名称列拖宽：最窄 180，最宽 760，且给日期留每天至少 12 像素',()=>{
 assert.equal(clampNameCol(100,1200),180);
 assert.equal(clampNameCol(420.4,1200),420);
 assert.equal(clampNameCol(900,1400),760);
 assert.equal(clampNameCol(700,1000),628);
});
test('3.0 显示：新轮次的 PO 风险读 risks 字段；旧轮次仍从约束与依赖里分出；人日正好等于容量的人做标记',()=>{
 const fresh={plan:{risks:['**窗口：**无授权时协调']},dependencies:['**材料：**10/12核对'],risks:['**窗口：**无授权时协调'],tradeoff:[]};
 assert.deepEqual(planColumns(fresh).map(([f,,rows])=>[f,rows.length]),[['tradeoff',0],['dependencies',1],['risks',1]]);
 const old={plan:{risks:['**窗口：**无授权时协调']},dependencies:['**材料：**10/12核对','**窗口：**无授权时协调'],tradeoff:[]};
 assert.deepEqual(planColumns(old).map(([f,,rows])=>[f,rows.length]),[['tradeoff',0],['dependencies',1],['risks',1]]);
 const w=workloadRows({personDays:[{name:'甲',personDays:12.8},{name:'乙',personDays:20}],capacity:{days:12.8},capacityFacts:[{name:'甲',exactlyAtCapacity:true}]},[]);
 assert.deepEqual(w.list.map(r=>[r.name,r.over,r.exact]),[['甲',false,true],['乙',true,false]]);
});
import {tierOf,tierInfo} from './v3-display.mjs';
test('档位只分 P0、P1、P2；旧轮次的前置按 P0、延伸按 P2 显示',()=>{
 assert.deepEqual(['前置','延伸','P0','P1','P2'].map(tierOf),['P0','P2','P0','P1','P2']);
 assert.deepEqual(Object.keys(tierInfo),['P0','P1','P2']);
});
import {roundSteps as roundStepsV3,roundLine as roundLineV3} from './round-steps.mjs';
import {ceoDecisions} from './entry-fields.mjs';
test('3.x 生成阶段：步骤条按战场、能力域、拆 Task、全局对齐、总校验走；2.x 照旧',()=>{
 const v3=stage=>roundStepsV3({status:'running',stage,skillSnapshot:{version:'3.1.1'}}).map(s=>s.state[0]).join('');
 assert.equal(v3('战场：并行生成 1/3'),'dctttt');
 assert.equal(v3('检查与修改：检查 0/3'),'ddcttt');
 assert.equal(v3('全局对齐：人日与优先级'),'ddddct');
 assert.equal(v3('精简：第 1 遍'),'dddddc');
 assert.equal(roundLineV3({status:'failed',stage:'拆 Task：并行生成',error:'超时',canResume:false,skillSnapshot:{version:'3.1.1'}},20),'停在拆 Task：超时。这次不能续跑，只能重新读取本体并生成。');
 assert.equal(roundStepsV3({status:'running',stage:'Mission 层：并行生成'}).length,5);
});
test('首页人员负荷：全局对齐留给 CEO 拍板的人手问题按人列出',()=>{
 assert.deepEqual(ceoDecisions({alignDecisions:{白田田:{decisionsForCEO:['bf03 推到 11 月还是加人？'],changed:3},王创峰:{decisionsForCEO:[],changed:1}}}),[{name:'白田田',text:'bf03 推到 11 月还是加人？'}]);
 assert.deepEqual(ceoDecisions({}),[]);
});
import {upstreamKey} from './todo.mjs';
test('上级调整的“待你处理”：打开过这张卡就不再算待处理',()=>{
 const m={id:'bf01-m1',unit:'bf01',level:'mission',title:'M',owner:'孙铭泽',upstreamChange:{cardId:'bf01',version:3},children:[]};
 const units=[{id:'bf01',level:'po',title:'PO',owner:'刘明华',children:[m]}],profile={member:true,name:'孙铭泽',unitDri:[],missions:['bf01-m1'],units:['bf01']};
 assert.equal(todoItems({units,profile,name:'孙铭泽'}).filter(i=>i.kind==='upstream').length,1);
 assert.equal(upstreamKey(m),'upstream:bf01-m1@bf01v3');
 assert.equal(todoItems({units,profile,name:'孙铭泽',seen:{[upstreamKey(m)]:Date.now()}}).filter(i=>i.kind==='upstream').length,0);
});
import {shortTitle} from './topic-lifecycle.mjs';
test('纪要：接着讨论的话（含发在卡片上的）并入当前话题；只表态“同意/不用改”不开新话题；标题只取第一句',()=>{
 const t=[];const at=n=>`2026-10-19T02:1${n}:00Z`;
 recordTopic(t,{id:'c1',channel:'group',author:'刘明华',text:'时间上没有容错啊？需要留出 buffer',cardId:'bf01',version:1,block:'logic',createdAt:at(1)});
 recordTopic(t,{id:'m1',channel:'group',author:'刘明华',text:'至少 3 天吧？',cardId:'bf01',general:true,createdAt:at(2)});
 recordTopic(t,{id:'m2',channel:'group',author:'孙铭泽',text:'我那条 Mission 的关口要一起改成 10/26',cardId:'bf01-m2',createdAt:at(3)});
 assert.equal(t.length,1);assert.deepEqual(t[0].sourceIds,['c1','m1','m2']);
 recordTopic(t,{id:'c2',channel:'group',author:'刘明华',text:'可决策状态是什么意思？要写清楚',cardId:'bf01',version:1,block:'result',createdAt:at(4)});
 assert.equal(t.length,2);assert.equal(t[1].status,'pending');
 const quiet=[];recordTopic(quiet,{id:'a1',channel:'group',author:'陈溪南',text:'已核对，我这条不用改。',cardId:'bf01-m3',createdAt:at(5)});
 assert.equal(quiet.length,0);
 assert.equal(shortTitle('已核对 PO v3：我这条 Mission 的关口从 10/29 改到 10/26，跟 PO 对齐。10/26 到 10/30 留给复测和回滚。'),'已核对 PO v3：我这条 Mission 的关口从 10/29 改到 10…');
});
test('里程碑每个只写日期加一句短句，不带引号括号',()=>{
 const g=gateEntries(['**内用边界（10/15）：**「内部供应按约结算且规则清楚」支撑。供应规则生效。','**日常调用（10/23）：**两项Mission支撑。']);
 assert.deepEqual(g.map(x=>[x.date,x.line]),[['10/15','内用边界，内部供应按约结算且规则清楚支撑'],['10/23','日常调用，两项Mission支撑']]);
});
import {markMentions} from './mentions.mjs';
test('群消息里 @真实成员或 Nexus 才变成提及，随手打的 @ 不变',()=>{
 assert.equal(markMentions('@孙铭泽 这个日期你那边能保证吗？'),'[@孙铭泽](mention:%E5%AD%99%E9%93%AD%E6%B3%BD) 这个日期你那边能保证吗？');
 assert.equal(markMentions('请 @Nexus 出卡'),'请 [@Nexus](mention:Nexus) 出卡');
 assert.equal(markMentions('邮件发 a@b.com，@张三 看看'),'邮件发 a@b.com，@张三 看看');
});
test('里程碑两种写法都认：名称（日期）和 日期 名称',()=>{
 const g=gateEntries(['**10/16 首轮就绪：**经营试点与研究服务备好首轮选择。','**10/30 首轮问题复测：**首轮研究修正阻断问题并复测。']);
 assert.deepEqual(g.map(x=>[x.date,x.name]),[['10/16','首轮就绪'],['10/30','首轮问题复测']]);
});
import {markBold} from './mentions.mjs';
test('Agent 回答里中文冒号后的加粗不再露出星号',()=>{
 assert.equal(markBold('- **验收：**孙铭泽的Mission'),'- [验收：](bold:)孙铭泽的Mission');
 assert.equal(markBold('普通 **重点** 文字'),'普通 [重点](bold:) 文字');
 assert.equal(markBold('没有加粗'),'没有加粗');
});
import {privateQuote} from './todo.mjs';
test('个人 Agent：问题引用当时选中的卡，回答引用它回答的那句',()=>{
 const list=[{author:'刘明华',text:'请审阅我当前选中的成果：核对成果、验收、时间与下层组合',context:{selection:{id:'bf01',version:2}}},{author:'Agent',text:'先改最重要的三处',context:{selection:{id:'bf01',version:2}}}];
 const cardLabel=id=>id==='bf01'?{ref:'Battlefield 1',title:'王总能用天枢研究集团经营问题'}:null;
 assert.deepEqual(privateQuote(list,0,{name:'刘明华',cardLabel}),{card:true,label:'Battlefield 1 · v2',text:'王总能用天枢研究集团经营问题'});
 assert.deepEqual(privateQuote(list,1,{name:'刘明华',cardLabel}),{author:'刘明华',text:'Battlefield 1｜请审阅我当前选中的成果：核对成果、验收、时间与下层组合'});
 assert.equal(privateQuote([{author:'刘明华',text:'你好'}],0,{name:'刘明华',cardLabel}),null);
});
