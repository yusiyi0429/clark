import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summaryInput,validateSummary,createProposalSummarizer} from './proposal-summary.mjs';
const p={id:'p',cardId:'rv:a',baseVersion:1,before:{verdict:'未达成'},patch:{verdict:'部分达成'},reason:'负责人补充事实'};
const complex={...p,before:{verdictReason:'原文缺少真实会议验收记录。'.repeat(8)},patch:{verdictReason:'负责人报告已测试但仍缺真实会议验收记录。'.repeat(8)}};
test('摘要使用提案基线，短判定值不用模型重写',()=>{const input=summaryInput(p,{verdict:'达成'});assert.equal(input.changes[0].before,'未达成');const summary=validateSummary({changes:[{index:0,before:'别的判断',after:'达成'}],reason:'补充事实'},input);assert.equal(summary.changes[0].after,'部分达成');assert.equal(summary.changes[0].before,'未达成');});
test('摘要缺项不能通过；没有原原因时保持空值',()=>{const input=summaryInput(p,{});assert.throws(()=>validateSummary({changes:[],reason:'x'},input));const empty=summaryInput({...p,reason:''},{});assert.equal(validateSummary({changes:[{index:0,before:'旧',after:'新'}],reason:'编造因果'},empty).reason,'');});
test('已编辑采纳提案使用acceptedPatch',()=>{const input=summaryInput({...p,edited:true,acceptedPatch:{verdict:'达成'}},{});assert.equal(input.changes[0].after,'达成');});
test('同范围并发请求只压缩一次，换人、换轮或内容改变则重新生成',async()=>{let calls=0;const summarize=createProposalSummarizer({complete:async()=>{calls++;return {answer:JSON.stringify({changes:[{index:0,before:'缺记录',after:'负责人报告测试，仍缺验收记录'}]})};}});await Promise.all([summarize(complex,{}, {actorId:'a',roundId:'r'}),summarize(complex,{}, {actorId:'a',roundId:'r'})]);assert.equal(calls,1);await summarize(complex,{}, {actorId:'b',roundId:'r'});await summarize(complex,{}, {actorId:'a',roundId:'r2'});await summarize({...complex,patch:{verdictReason:'新的原文'.repeat(20)}}, {},{actorId:'a',roundId:'r'});assert.equal(calls,4);});

test('摘要失败缓存完整原文对照，内容版本变化后重新整理',async()=>{let n=0;const summarize=createProposalSummarizer({complete:async()=>{n++;throw Error('temporary');}});assert.equal((await summarize(complex,{})).full,true);assert.equal((await summarize(complex,{})).changes[0].after,complex.patch.verdictReason);assert.equal(n,1);await summarize({...complex,baseVersion:2},{});assert.equal(n,2);});

test('隐藏原因由程序保留，不依赖模型生成',()=>{const input=summaryInput(p,{});assert.equal(validateSummary({changes:[{index:0,before:'旧',after:'新'}]},input).reason,p.reason);});
test('拒绝把仍缺验收升级成连续采用和真实验收通过',()=>{const input={changes:[{where:'证据',before:'尚未有正式验收及真实会议的连续采用记录',after:'负责人报告入会可用，5秒延迟仍缺真实会议验收'}],reason:'负责人补充事实'};assert.throws(()=>validateSummary({changes:[{index:0,before:'缺记录',after:'已连续采用三周并通过真实验收'}],reason:'负责人补充事实'},input));});
test('拒绝把缺记录改成没发生，或延迟丢失5秒',()=>{const input={changes:[{where:'证据',before:'本体中没有这次持续采用行为的任何进展记录',after:'负责人报告多场会议使用；5秒延迟仍缺真实会议验收'}],reason:'负责人报告'};assert.throws(()=>validateSummary({changes:[{index:0,before:'没有发生',after:'负责人报告多场使用；延迟缺验收'}],reason:'负责人报告'},input));});
test('Mission新增完整输入保留所有字段；撤掉与恢复包含影响',()=>{const mission={title:'目标',owner:'甲',time:'2026-11-30',result:'联调通过',checks:['验收一'],tasks:[{title:'任务',owner:'乙',time:'2026-11-10',result:'子结果',checks:['子验收']}]};const add=summaryInput({op:'add-mission',mission,patch:{}},{});assert.deepEqual(add.changes[0].after.mission,mission);for(const op of ['withdraw-mission','restore-mission']){const input=summaryInput({op,missionSummary:{title:'目标',tasks:3,owner:'甲'},missionId:'m1',patch:{}},{});assert.equal(input.changes[0].after.mission.tasks,3);assert.match(input.changes[0].after.impact,/全部 Task/);assert.notEqual(input.changes[0].before.status,input.changes[0].after.status);}});

test('事实重排按稳定ref对齐，不把不同事项拼成前后变化',()=>{const a={ref:'a',item:'甲',status:'未达成',evidence:'旧甲',gap:''},b={ref:'b',item:'乙',status:'达成',evidence:'旧乙',gap:''};const v=summaryInput({before:{facts:[a,b]},patch:{facts:[{...b,evidence:'新乙'},a]}},{});assert.equal(v.changes.length,1);assert.match(v.changes[0].where,/乙/);assert.equal(v.changes[0].before,'旧乙');assert.equal(v.changes[0].after,'新乙');});
test('重复ref不猜对应，原始输入仍保留全部值',()=>{const facts=[{ref:'a',item:'甲',evidence:'甲'},{ref:'a',item:'乙',evidence:'乙'}];const v=summaryInput({before:{facts},patch:{facts:[]}},{});assert.equal(v.ambiguous,true);assert.deepEqual(v.changes[0].before,facts);assert.throws(()=>validateSummary({changes:[],reason:''},v));});
test('来源前后分别绑定，不依赖共享reason补来源',()=>{const old={ref:'a',item:'甲',evidence:'据陈溪南反馈，服务仅上线',gap:'无验收材料'},now={...old,evidence:'本人报告入会可用',gap:'5秒延迟未实会验证'};const v=summaryInput({before:{facts:[old]},patch:{facts:[now]},reason:'材料更新'},{});assert.equal(v.changes[0].beforeSource,'据陈溪南反馈');assert.equal(v.changes[0].afterSource,'本人报告');assert.equal(v.changes[1].afterSource,'本人报告');});
test('否定按分句处理；模型原因不会进入程序结果',()=>{const input={changes:[{where:'证据',before:'前期尚无有效验收材料，情况需要核对',after:'入会已上线，5秒延迟尚待验收'}],reason:'补充本人报告'};for(const reason of ['未上线，但已通过客户验收','已核验','已用了三周','持续运行三周','上线2次'])assert.equal(validateSummary({changes:[{index:0,before:'缺材料',after:'入会已上线，5秒延迟待验收'}],reason},input).reason,input.reason); assert.throws(()=>validateSummary({changes:[{index:0,before:'没有发生',after:'入会已连续采用三周，5秒验收通过'}]},{...input,changes:[{...input.changes[0],after:'负责人报告入会已上线，5秒延迟尚待真实会议验收，目前暂无其他验收材料'}]}));});

test('直接Mission判定修订保留实际编号和名称，不用字段名代替对象',()=>{const v=summaryInput({...p,cardId:'rv:agents-m4'},{id:'rv:agents-m4',level:'mission',title:'参加内部飞书会议'});assert.equal(v.changes[0].targetLabel,'Mission 4 · 参加内部飞书会议');const r=validateSummary({changes:[{index:0,before:'旧',after:'新',targetLabel:'伪造'}],reason:'负责人补充事实'},v);assert.equal(r.changes[0].targetLabel,'Mission 4 · 参加内部飞书会议');});
test('直接PO和Task修订显示正确范围，不猜Mission编号',()=>{const po=summaryInput({...p,cardId:'rv:agents'},{id:'rv:agents',level:'po',title:'Agents十月'});assert.equal(po.changes[0].targetLabel,'PO 复盘 · Agents十月');const task=summaryInput({...p,cardId:'agents-m4-t2'},{id:'agents-m4-t2',level:'task',title:'补验证'});assert.equal(task.changes[0].targetLabel,'Mission 4 · Task 2 · 补验证');});
test('无规范编号时沿用已知referenceLabel和名称，不从标题猜号',()=>{const v=summaryInput({...p,cardId:'opaque-id'},{level:'review-mission',referenceLabel:'个人复盘 · Mission 4',title:'会议'});assert.equal(v.changes[0].targetLabel,'个人复盘 · Mission 4 · 会议');});
test('新增、撤掉、恢复均以操作的Mission为目标，不误标父PO',()=>{for(const op of ['add-mission','withdraw-mission','restore-mission']){const v=summaryInput({op,cardId:'agents',missionId:op==='add-mission'?undefined:'agents-m4',mission:{title:'新增事项',tasks:[]},missionSummary:{title:'原事项',tasks:3},patch:{}},{id:'agents',level:'po',title:'父PO'});assert.match(v.changes[0].targetLabel,op==='add-mission'?/^Mission · 新增事项$/:/^Mission 4 · 原事项$/);assert.doesNotMatch(v.changes[0].targetLabel,/父PO/);}});
test('before已有键盘麦也不能在after省掉，不能用其他待验收替代5秒',()=>{const input={changes:[{where:'证据',before:'入会和键盘麦都缺少真实会议中的验收材料',after:'负责人报告入会和键盘麦可用，5秒延迟仍无真实会议验收'}],reason:'负责人补充事实'};for(const after of ['负责人报告入会可用；其他待验收','入会和键盘麦可用；其他待验收','入会可用；5秒仍待验收'])assert.throws(()=>validateSummary({changes:[{index:0,before:'缺材料',after}],reason:'负责人补充事实'},input));});


test('未变键盘麦背景可省略；改变的键盘麦能力仍必须保留',()=>{
 const background='键盘麦10/26本人实测可用。负责人报告：键盘麦控制精准，语音唤醒可用。';
 const input={changes:[{where:'证据',before:background+'打断、5秒延迟无真实会议验收。',after:background+'负责人报告打断和5秒延迟在真实会议验证过；场次日期未写明，材料暂无记录。'}],reason:''};
 assert.doesNotThrow(()=>validateSummary({changes:[{index:0,before:'打断、5秒延迟无实会验收',after:'负责人称打断、5秒延迟会议验证过；场次日期未写，暂无记录'}],reason:''},input));
 const changed={changes:[{where:'证据',before:background+'尚无验收材料。',after:'键盘麦10/26本人实测可用。负责人报告：键盘麦已获真实会议确认，语音唤醒可用。尚无验收材料。'}],reason:''};
 assert.throws(()=>validateSummary({changes:[{index:0,before:'尚无材料',after:'语音唤醒可用，尚无材料'}],reason:''},changed),/遗漏/);
});
test('UUID事实复用已知个人Mission编号，PO下未知UUID不猜编号',()=>{
 const fact={ref:'11111111-2222-4333-8444-555555555555',item:'唤醒和打断体验',evidence:'旧证据'};
 const proposal={cardId:'rv:agents-m4',before:{facts:[fact]},patch:{facts:[{...fact,evidence:'新证据'}]}};
 const input=summaryInput(proposal,{id:'rv:agents-m4',level:'mission',title:'参加内部飞书会议'});
 assert.equal(input.changes[0].targetLabel,'Mission 4 · 唤醒和打断体验');
 const po=summaryInput({...proposal,cardId:'rv:agents'},{id:'rv:agents',level:'po',title:'Agents'});
 assert.equal(po.changes[0].targetLabel,'唤醒和打断体验');
});


test('长原原因逐字保留，模型缺失或新增5秒均不影响隐藏原因',()=>{
 const input={changes:[{where:'证据',before:'打断和5秒延迟缺实会验收',after:'负责人报告打断和5秒延迟会议验证过，缺场次日期'}],reason:'打断和延迟验证补入答复并去掉提问'.repeat(8)};
 for(const reason of [undefined,'补入打断和5秒延迟验证答复','已通过验收',null]){
 const result=validateSummary({changes:[{index:0,before:'打断、5秒延迟缺实会验收',after:'负责人称打断、5秒延迟会议验证过，缺场次日期'}],reason},input);assert.equal(result.reason,input.reason);}
});
test('模型输入不再请求隐藏原因，简单和空改动均不调用模型',async()=>{let calls=0;const summarizer=createProposalSummarizer({complete:async messages=>{calls++;assert.equal(JSON.parse(messages[1].content).reason,undefined);return {answer:JSON.stringify({changes:[{index:0,before:'缺记录',after:'仍缺验收'}]})};}});assert.equal((await summarizer(p,{})).reason,p.reason);assert.equal(calls,0);assert.deepEqual(await summarizer({...p,patch:{},before:{}},{}),{changes:[],reason:p.reason});assert.equal((await summarizer(complex,{})).reason,p.reason);assert.equal(calls,1);});

test('无效JSON或超长摘要只尝试一次，完整原文兜底可读且缓存',async()=>{for(const answer of ['{broken',JSON.stringify({changes:[{index:0,before:'缺记录',after:'超长'.repeat(30)}]})]){let calls=0;const summarize=createProposalSummarizer({complete:async(_,opts)=>{calls++;assert.ok(opts.timeoutMs<=15000);return {answer};}});const result=await summarize(complex,{});assert.equal(result.full,true);assert.equal(result.changes[0].after,complex.patch.verdictReason);await summarize(complex,{});assert.equal(calls,1);}});

test('事实守卫失败不能展示坏摘要，完整原文不改patch',async()=>{const proposal={...complex,patch:{verdictReason:'负责人报告入会和键盘麦可用，5秒延迟仍无真实会议验收。'.repeat(5)}};let calls=0;const raw=JSON.stringify(proposal);const summarize=createProposalSummarizer({complete:async()=>{calls++;return {answer:JSON.stringify({changes:[{index:0,before:'没有发生',after:'已持续采用三周，已通过验收'}]})};}});const result=await summarize(proposal,{});assert.equal(result.full,true);assert.equal(result.changes[0].after,proposal.patch.verdictReason);await summarize(proposal,{});assert.equal(calls,1);assert.equal(JSON.stringify(proposal),raw);});

test('清空字段由程序显示清空，原空字段显示空白，不改变输入或patch',()=>{
 for(const status of ['pending','accepted'])for(const empty of ['','  ']){
 const fact={ref:'fact-uuid',item:'入会体验',gap:'原有原因',evidence:'负责人报告入会可用'};
 const proposal={id:'empty-'+status,status,cardId:'rv:agents-m4',before:{facts:[fact]},patch:{facts:[{...fact,gap:empty}]}};
 const snapshot=JSON.stringify(proposal);const input=summaryInput(proposal,{});
 const result=validateSummary({changes:[{index:0,before:'模型旧',after:'模型不应新增内容'}]},input);
 assert.equal(result.changes[0].after,'清空');assert.equal(JSON.stringify(proposal),snapshot);assert.equal(input.changes[0].after,empty);
 const addInput=summaryInput({...proposal,before:{facts:[{...fact,gap:empty}]},patch:{facts:[{...fact,gap:'补充记录'}]}},{});
 const add=validateSummary({changes:[{index:0,before:'模型旧',after:'模型新'}]},addInput);
 assert.equal(add.changes[0].before,'空白');assert.equal(add.changes[0].after,'补充记录');
 }
});
test('full comparison renders structured source as labelled text after timeout, retaining every raw value and field',async()=>{
 const {completeComparison}=await import('./proposal-summary-input.mjs');
 const before={ref:'t1',item:'上线访问',owner:'孙铭泽',status:'未达成',evidence:'缺原始记录 [E5]',gap:'待核',custom:'原样保留'};
 const after={...before,status:'达成',evidence:'负责人报告已上线，但未独立核验 [event-855]',gap:''};
 const proposal={id:'readable-fallback',cardId:'rv:eo-m1',before:{facts:[before],nextInputs:[{ref:'t1',type:'继续',text:'继续核实',ask:{to:'孙铭泽',question:'哪天？'}}]},patch:{facts:[after],nextInputs:[]}};
 const original=JSON.stringify(proposal),result=completeComparison(proposal,{});
 assert.match(result.changes[0].before,/事项：上线访问/);assert.match(result.changes[0].after,/状态：达成/);assert.ok(result.changes[0].after.includes(after.evidence));assert.match(result.changes[0].before,/custom：原样保留/);assert.match(result.changes[1].before,/问谁：孙铭泽/);assert.equal(result.changes[1].after,'（无条目）');assert.doesNotMatch(result.changes[0].after,/"ref"\s*:/);assert.equal(JSON.stringify(proposal),original);
 let calls=0;const summarize=createProposalSummarizer({complete:async()=>{calls++;throw Error('timeout');}});const fallback=await summarize(proposal,{});assert.equal(fallback.full,true);assert.ok(fallback.changes[0].after.includes(after.evidence));assert.equal(calls,1);assert.equal(JSON.stringify(proposal),original);
});
