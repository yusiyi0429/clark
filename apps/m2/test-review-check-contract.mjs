import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState} from './governance.mjs';
import {installReviewRound} from './review-round.mjs';
import {checkedReviewIssues,requiredReviewIssue,runReviewSkill,reviewQualityWarnings,reviewFile} from './review-generation.mjs';
const skill={version:'2.1.12',mustFix:['判定偏严']};
const issue={ref:'m',type:'结构与表达',problem:'操作者和动作不清楚',impact:'无法判断实际做到了什么',mustFix:true,fixable:true};
test('critical expression and evidence issues are required; ordinary polish stays optional',()=>{
 assert.equal(requiredReviewIssue(issue,skill),true);
 assert.equal(requiredReviewIssue({...issue,mustFix:false},skill),false);
 assert.equal(requiredReviewIssue({...issue,type:'判定偏严',mustFix:false},skill),true);
 assert.equal(requiredReviewIssue({...issue,fixable:false},skill),false);
 assert.deepEqual(checkedReviewIssues({issues:[issue]},{skill,refs:['m']}),[issue]);
});
test('new checker contract fails closed on absent arrays, required flags, impacts and invalid review refs',()=>{
 for(const value of [{},{issues:null},{issues:[{...issue,mustFix:undefined}]},{issues:[{...issue,fixable:'true'}]},{issues:[{...issue,impact:''}]},{issues:[{...issue,ref:'unknown'}]}])assert.throws(()=>checkedReviewIssues(value,{skill,refs:['m']}));
 assert.deepEqual(checkedReviewIssues({issues:[]},{skill,refs:['m']}),[]);
});
const input={stages:[[{id:'m',level:'mission',unit:'u',title:'M',owner:'陈溪南',parent:'u',evidence:[]}],[{id:'u',level:'ru',unit:'u',title:'U',owner:'刘明华',children:['m'],evidence:[]}],[{id:'company',level:'company',unit:'company',title:'公司',owner:'刘明华',children:['u'],evidence:[]}]]};
const legacySkill={...skill,version:'2.0.4',rules:'规则',hash:'test',groups:[{name:'表达',types:['结构与表达']}]};
test('checker transport failure propagates instead of becoming zero issues',async()=>{
 const run={raw:{},reviews:{},failed:[],dropped:[]};let checks=0;
 const gateway={complete:async messages=>{const p=JSON.parse(messages[1].content);if(!p.unit){checks++;throw Error('checker unavailable');}return {answer:JSON.stringify({review:{verdict:'未达成',facts:[],nextInputs:[]}})};}};
 await assert.rejects(runReviewSkill({gateway,skill:legacySkill,input,run}),/checker unavailable/);
 assert.equal(checks,3,'the existing per-request transport retry bound is retained');assert.notEqual(run.checked,true);
});
test('checker mustFix flag causes a critical expression revision even outside original required types',async()=>{
 const revised=[];const gateway={complete:async messages=>{const p=JSON.parse(messages[1].content);if(!p.unit)return {answer:JSON.stringify({issues:[issue]})};if(p.issues)revised.push(p.unit.id);return {answer:JSON.stringify({review:{verdict:'未达成',facts:[],nextInputs:[]}})};}};
 await runReviewSkill({gateway,skill:legacySkill,input});assert.deepEqual(revised,['m']);
});

test('a failed or empty required revision cannot silently pass as the unchanged draft',async()=>{
 for(const failed of [false,true]){
  const gateway={complete:async messages=>{const p=JSON.parse(messages[1].content);if(!p.unit)return {answer:JSON.stringify({issues:[issue]})};if(p.issues){if(failed)throw Error('revision unavailable');return {answer:'{}'};}return {answer:JSON.stringify({review:{verdict:'未达成',facts:[],nextInputs:[]}})};}};
  await assert.rejects(runReviewSkill({gateway,skill:legacySkill,input}),failed?/revision unavailable/:/返修未返回复盘/);
 }
});

test('malformed checker answers are archived and cannot poison resume with a cached false pass',async()=>{
 const run={raw:{},reviews:{},failed:[],dropped:[]};let bad=true,checks=0;
 const gateway={complete:async messages=>{const p=JSON.parse(messages[1].content);if(!p.unit){checks++;return {answer:JSON.stringify(bad?{}:{issues:[]})};}return {answer:JSON.stringify({review:{verdict:'未达成',facts:[],nextInputs:[]}})};}};
 await assert.rejects(runReviewSkill({gateway,skill:legacySkill,input,run}),/issues 数组/);
 assert.equal(run.raw['check-1'],undefined);assert.equal(run.checkFailures[0].raw,'{}');assert.notEqual(run.checked,true);
 bad=false;await runReviewSkill({gateway,skill:legacySkill,input,run});assert.equal(run.checked,true);assert.equal(checks,2);
});

test('unfixable source gaps remain explicit in exported reviews and installed round warnings',()=>{
 const warning={...issue,fixable:false,problem:'缺少截至月底的实际结果',impact:'尚不能判断稳定性'};
 const run={reviews:{m:{title:'参会',level:'mission',owner:'陈溪南',unit:'u',ref:'m',verdict:'部分达成',facts:[],nextInputs:[]}},issues:[warning],failed:[],dropped:[]};
 assert.equal(reviewQualityWarnings(run)[0].problem,warning.problem);
 const file=reviewFile(run,{...input,period:'2026-10',cutoff:'2026-10-31',skipped:[]},{skill:legacySkill,model:'test',label:'候选'});
 assert.equal(file.qualityWarnings[0].impact,warning.impact);
 const state=installReviewRound(createCollaborationState([]),file);
 assert.ok(state.reviewRound.problems.some(x=>x.kind==='unresolved'&&x.reason.includes(warning.problem)&&x.reason.includes(warning.impact)));
});
