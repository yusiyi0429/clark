import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {generateRoundV3,toDisplay,personDays,demandFacts,upstreamFactsV3,battlefieldKeys,workdaysLeft,capacityFacts,splitFacts,tierFacts,vagueFindings,gateMilestone,scheduleShapeFacts,placementFacts} from './round-runner-v3.mjs';
import {readerPolicy} from './reader-quality.mjs';

const skillDir=new URL('./.runtime/eval/skills/tkos-decoding-3.1.3/references/',import.meta.url);
const rules=await readFile(new URL('round-stages.md',skillDir),'utf8').catch(()=>'必须修改的问题类型：真重复、负荷。\n- 第一组（跨领域）：真重复\n- 第二组（负荷）：负荷\n交叉验证最多做 1 轮');
const policy=readerPolicy(await readFile(new URL('reader-format.md',skillDir),'utf8').catch(()=>''));
const keys=['bf01','bf02','bf03','rearch','method','agents','eo','tokenhub','talent','finance'];
const owner={bf01:'孙铭泽',bf02:'王创峰',bf03:'白田田',rearch:'白田田',method:'白田田',agents:'孙铭泽',eo:'刘人豪',tokenhub:'王创峰',talent:'秦梦怡',finance:'唐巨杰'};
const unitAnswer=(key,stage)=>({analysis:'想清楚了',po:{title:`${key} 本月结果成立`,owner:owner[key],result:'月底某状态成立。',checks:['**数量：**至少 3 次真实使用。'],contribution:'推进长期目标。',done:['**不算：**演示不算。'],plan:{path:['**首次使用（10/16）：**M1 支撑，首次真实使用发生。'],tradeoffs:['**范围：**先做一个场景。'],dependencies:['**握手：**刘明华 10/12 确认范围。'],risks:['**窗口：**客户延后则改期。']}},
 missions:[{title:`${key} 第一条结果线成立`,owner:owner[key],tier:'P0',time:'2026-10-09—2026-10-28',gate:'10/16 首次使用',result:'某人能做成某事。',why:'补上缺口。',checks:['**数量：**3 次。'],boundary:['**交接：**交给下游。'],route:'准备→使用→修正',risks:[]}],
 upstream:[{element:'长期要求一',disposition:'承接',missionTitle:`${key} 第一条结果线成立`},{element:'长期要求二',disposition:'暂缓',note:'本月不做'}],
 ...(stage==='battlefield-generate'?{demands:[{to:'tokenhub',what:'调用入口',by:'2026-10-14',use:'首次使用'}]}:{}),
 ...(stage==='domain-generate'&&key==='tokenhub'?{responses:[{demandId:'bf01-D1',response:'接',missionTitle:'tokenhub 第一条结果线成立'}]}:{}),
 ...(stage==='domain-generate'&&key==='agents'?{demands:[{to:'tokenhub',what:'内部 Agent 调用的鉴权方式',by:'2026-10-15',use:'接入平台'}]}:{}),gaps:[]});
function fakeGateway(log){
 return {readerPolicy:policy,roundConcurrency:4,async complete(messages){
  const p=JSON.parse(messages[1].content);log.push(p.stage+':'+(p.key||'all'));
  let answer;
  if(p.stage==='battlefield-generate'||p.stage==='domain-generate'){assert.ok(p.stage!=='domain-generate'||p.battlefields.length===3,'能力域生成时应看到战场摘要');if(p.key==='tokenhub')assert.equal(p.demands.length,3,'TokenHub 应收到三个战场写给它的需求');answer=unitAnswer(p.key,p.stage);}
  else if(p.stage.endsWith('-check')){assert.ok(p.personDays&&p.demandFacts&&p.upstreamFacts);answer={issues:p.stage==='check-check'&&p.focus?.name?.includes('负荷')?[{unitKey:'eo',cardId:'m1',cardTitle:'eo 第一条结果线成立',type:'负荷',problem:'刘人豪超载',impact:'P0 落空',repairable:true}]:[],gaps:[],summary:'ok'};}
  else if(p.stage==='check-revise'&&p.key==='tokenhub'){assert.ok(p.openDemands?.some(d=>d.from==='agents'),'TokenHub 修改时看到 Agents 提的、还没回应的需求');answer={changes:[{op:'replace',id:'po',card:{...p.current.po,responses:[...(p.current.po.responses||[]),{demandId:p.openDemands.find(d=>d.from==='agents').id,response:'接',missionTitle:'tokenhub 第一条结果线成立'}]}}],gaps:[]};}
  else if(p.stage==='check-revise'){answer={changes:[{op:'replace',id:'m1',card:{...p.current.missions[0],tier:'P1',why:'降档：容量不足，RU DRI 取舍。'}}],gaps:[]};}
  else if(p.stage==='align-generate'){assert.ok(p.work.length>0&&p.person.over>0,'超载的人才进全局对齐');const w=p.work[0];answer={analysis:'',changes:[{id:w.id,defer:true,reason:'下月再做'}],decisionsForCEO:['缺 3 人日'],gaps:[]};}
  else if(p.stage==='task-generate'){assert.ok(p.personDayBudget.days>0,'拆 Task 时给出负责人的人日预算');assert.match(messages[0].content,/拆解日为2026-10-09/);answer={analysis:'',time:'2026-10-09—2026-10-27',tasks:[{title:'调用入口可供首用',owner:p.mission.owner,time:'2026-10-09—2026-10-15',result:'一个能调用的入口。',checks:['**规格：**密钥不明文落库。'],effort:p.key==='eo'?'约 20 人日，含联调和返工':'约 4 人日，含联调和返工',stop:'安全未过时停，找刘人豪。',dependsOn:[]}],mission:null,gaps:[]};}
  else answer={changes:[],gaps:[]};
  return {answer:JSON.stringify(answer),usage:{}};
 }};
}
test('3.x 流程：战场先写并提需求，能力域收到需求后回应，检查后按卡片修改，再按 Mission 拆 Task',async()=>{
 const temp=await mkdtemp(tmpdir()+'/v3-');process.env.DECODING_RUNS_DIR=temp;
 try{
  const log=[],progress=[];
  const result=await generateRoundV3({gateway:fakeGateway(log),rules,fetchSources:async()=>({period:'2026-10',planningDate:'2026-10-09',sources:keys.map(key=>({key,content:`${key} 资料\n【本月意图】${key} 10 月目标（草稿）· 成果\n原文`}))}),onProgress:async p=>progress.push(p)});
  const firstDomain=log.findIndex(x=>x.startsWith('domain-generate'));
  assert.ok(log.slice(0,firstDomain).every(x=>x.startsWith('battlefield-generate'))&&firstDomain===3,'先生成三个战场');
  assert.equal(log.filter(x=>x.startsWith('domain-generate')).length,7);
  assert.equal(log.filter(x=>x.startsWith('task-generate')).length,10);
  assert.ok(log.includes('check-revise:eo'),'负荷问题交给 eo 修改');
  const eo=result.raw.find(u=>u.key==='eo');
  assert.match(eo.missions[0].why[0],/降档/);
  assert.ok(log.includes('align-generate:刘人豪'),'刘人豪超载，进入全局对齐');
  assert.equal(eo.missions[0].tier,'P2','唯一的 Task 被推迟后，Mission 降为 P2 并保留 Task');
  assert.ok(eo.tradeoff.some(t=>t.startsWith('**推迟：**')),'推迟的工作写进单元计划的取舍');
  assert.deepEqual(result.audit.alignDecisions['刘人豪'].decisionsForCEO,['缺 3 人日']);
  assert.deepEqual(eo.milestones,['10/16 首次使用']);
  assert.equal(eo.time,'2026-10-01—2026-10-31');
  assert.equal(result.counts.mission,10);assert.equal(result.counts.task,10);
  assert.ok(progress.some(p=>Array.isArray(p.partialUnits)&&p.partialUnits.length===3),'战场写完就有可展示的部分结果');
  assert.ok(log.includes('check-revise:tokenhub'),'有未回应的需求时，被提需求的领域也进入修改');
  assert.equal(result.audit.demandFacts.find(d=>d.from==='agents').response,'接','能力域之间的需求在修改时得到回应');
  assert.equal(result.audit.demandFacts.filter(d=>d.dangling).length,2,'bf02、bf03 的需求没有被 TokenHub 回应');
  assert.equal(result.audit.upstreamCoverage.bf01.length,2);
  assert.deepEqual([result.audit.capacity.days,result.audit.capacity.from,result.audit.capacity.to],[16,'2026-10-09','2026-10-31']);assert.match(result.audit.capacity.basis,/16 个工作日/);
 }finally{await rm(temp,{recursive:true,force:true});delete process.env.DECODING_RUNS_DIR;}
});
test('人日、需求和上级要素统计按 3.x 字段计算',()=>{
 const units=[{po:{key:'a',demands:[{id:'a-D1',to:'b'}]},upstream:[{id:'a-U1',disposition:'承接',missionTitle:'M'},{id:'a-U2',disposition:'承接',missionTitle:'不存在'}],missions:[{title:'M',owner:'甲',tasks:[{owner:'甲',effort:'约3–5人日'},{owner:'乙',effort:'2 人日'}]}]},{po:{key:'b',responses:[{demandId:'a-D1',response:'接',missionTitle:'M'}]},missions:[]}];
 assert.deepEqual(personDays(units).map(p=>[p.name,p.personDays]),[['甲',5],['乙',2]]);
 assert.equal(demandFacts(units)[0].dangling,false);
 assert.deepEqual(upstreamFactsV3(units),{owed:2,covered:1,uncovered:[{id:'a-U2',element:undefined,listedBy:'a',missionTitle:'不存在'}]});
 assert.deepEqual(battlefieldKeys,['bf01','bf02','bf03']);
 const shown=toDisplay({po:{key:'a',title:'t',owner:'甲',result:'r',checks:['c'],done:['d'],contribution:'贡献',plan:{path:['**首用（10/16）：**x']}},missions:[]},'2026-10');
 assert.deepEqual(shown.checks,['c','d']);assert.deepEqual(shown.milestones,['10/16 首用']);
});
test('可用人日按拆解日到月末的工作日算，默认全职只做拆出来的工作',()=>{
 assert.equal(workdaysLeft('2026-10-09','2026-10'),16);
 const c=capacityFacts([{po:{key:'a'},missions:[{tasks:[{owner:'王创峰',effort:'20 人日'}]}]}],{from:'2026-10-09',period:'2026-10',capacity:{hoursPerWorkday:8,otherWorkHours:0}});
 const w=c.find(p=>p.name==='王创峰');assert.equal(w.capacityDays,16);assert.equal(w.over,4);
 const exact=capacityFacts([{po:{key:'a'},missions:[{tasks:[{owner:'孙铭泽',effort:'16 人日'}]}]}],{from:'2026-10-09',period:'2026-10',capacity:{}}).find(p=>p.name==='孙铭泽');assert.equal(exact.exactlyAtCapacity,true,'正好等于容量的估计要标出来');assert.ok(!c.some(p=>p.name==='刘明华'),'CEO 不计入执行容量');
});
test('同一批修改里先整张替换 Mission（带下级），后面仍能按编号改它的 Task',async()=>{
 const {applyChanges}=await import('./round-runner.mjs');
 const state={po:{title:'p'},missions:[{title:'m',tasks:[{title:'a'},{title:'b'},{title:'c'}]}]};
 const next=applyChanges(state,[{op:'replace',id:'m1',card:{title:'m 改',tasks:[{title:'a'},{title:'b'},{title:'c'}]}},{op:'replace',id:'m1-t3',card:{title:'c 改'}}]);
 assert.deepEqual(next.missions[0].tasks.map(t=>t.title),['a','b','c 改']);assert.equal(next.missions[0].title,'m 改');
});
test('同一人在同一领域负责多条 Mission 时列出，供检查“拆散”',()=>{
 const f=splitFacts([{po:{key:'bf02'},missions:[{title:'调用进入日常使用',owner:'王创峰',tier:'P0'},{title:'账实一致',owner:'唐巨杰',tier:'P0'},{title:'调用降低成本',owner:'王创峰',tier:'P1'}]}]);
 assert.deepEqual(f,[{unit:'bf02',owner:'王创峰',missions:[{id:'m1',title:'调用进入日常使用',tier:'P0'},{id:'m3',title:'调用降低成本',tier:'P1'}]}]);
});
test('Task 档位高于所属 Mission、或全部照抄 Mission 档位时列出',()=>{
 const f=tierFacts([{po:{key:'a'},missions:[{tier:'P1',tasks:[{title:'x',tier:'P0'},{title:'y',tier:'P1'}]},{tier:'P0',tasks:[{tier:'P0'},{tier:'P0'},{tier:'P0'}]}]}]);
 assert.deepEqual(f,[{unit:'a',mission:'m1',task:'m1-t1',taskTier:'P0',missionTier:'P1',title:'x'},{unit:'a',mission:'m2',allTasksCopyMissionTier:'P0'}]);
});
test('档位要分出先后：全公司 P0 明显多于三分之一、P0 Mission 里 P0 Task 过半都列出',()=>{
 const f=tierFacts([{po:{key:'a'},missions:[{tier:'P0',tasks:[{tier:'P0'},{tier:'P0'},{tier:'P1'}]},{tier:'P0',tasks:[]},{tier:'P1',tasks:[]}]}]);
 assert.equal(f[0].scope,'company');assert.equal(f[0].P0,2);
 assert.ok(f.some(x=>x.mission==='m1'&&x.note==='P0 Task 超过一半'));
});
test('要人再翻译的说法（如“可决策状态”“入口”）列给修改和精简',()=>{
 const f=vagueFindings({key:'bf01',title:'集团经营问题进入可决策状态',result:'王总在选项里做出选择',missions:[{title:'王总正式经营入口可供使用',result:'王总每周用 1 次',tasks:[]}]});
 assert.deepEqual(f.map(x=>[x.fieldPath,x.actual]),[['unit.title','可决策'],['unit.missions[0].title','入口']]);
});
test('里程碑两种写法都能读出：“名称（MM/DD）”和“MM/DD 名称”',()=>{
 assert.equal(gateMilestone('**首用（10/16）：**x'),'10/16 首用');
 assert.equal(gateMilestone('**10/16 首轮就绪：**经营试点备好'),'10/16 首轮就绪');
 assert.equal(gateMilestone('没有日期'),null);
});

test('schedule shape facts flag finish-to-start chains, P0 at month end and sub-day Tasks',()=>{
 const units=[{po:{key:'bf01'},missions:[{title:'M',tier:'P0',tasks:[
  {title:'资料包',time:'2026-10-12—2026-10-16',effort:'人约 3 人日',dependsOn:[]},
  {title:'首次使用',time:'2026-10-19—2026-10-30',effort:'人约 2 人日',dependsOn:['资料包']},
  {title:'清单',time:'2026-10-22—2026-10-23',effort:'人约 0.5 人日',dependsOn:[]}]}]}];
 const f=scheduleShapeFacts(units,{from:'2026-10-09',period:'2026-10'});
 assert.deepEqual(f.finishToStart.map(x=>[x.from,x.to]),[['m1-t1','m1-t2']]);
 assert.equal(f.p0AtMonthEnd[0].lastTaskEnds,'2026-10-30');
 assert.deepEqual(f.smallTasks.map(x=>x.task),['m1-t3']);
 assert.deepEqual(f.lateStarts.map(x=>x.task),['m1-t3']);
});

test('a replacement card that leaves out demands keeps them; a domain Mission serving one battlefield is flagged',async()=>{
 const {applyChanges}=await import('./round-runner.mjs');
 const state={po:{title:'PO',demands:[{id:'bf01-D1',to:'agents',what:'验收'}]},missions:[],upstream:[]};
 assert.equal(applyChanges(state,[{op:'replace',id:'po',card:{title:'短一点的 PO'}}]).po.demands[0].id,'bf01-D1');
 const units=[{po:{key:'bf01',demands:[{id:'bf01-D1',to:'agents'}]},missions:[]},{po:{key:'agents',responses:[{demandId:'bf01-D1',response:'部分接',missionTitle:'先行版验收'}]},missions:[{title:'先行版验收'},{title:'长线能力'}]}];
 assert.deepEqual(placementFacts(units).map(x=>[x.unit,x.mission,x.onlyServes]),[['agents','m1','bf01']]);
});
