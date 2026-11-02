import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runReviewQuality,qualityModelCall,qualityHash} from './review-quality.mjs';
import {reviewFile,loadReviewSkill,runReviewSkill} from './review-generation.mjs';
import {installReviewRound} from './review-round.mjs';
import {createCollaborationState} from './governance.mjs';

const skill={hash:'frozen-skill',maxRevisionRounds:2,mustFix:['critical']};
const input={stages:[[{id:'m',parent:'u'}],[{id:'u',parent:'company',children:['m']}],[{id:'company',children:['u']}]]};
const sources={m:{evidence:[{id:'E43',text:'真实会议验证仍待实会'},{id:'E49',text:'问题清单：快嘴；其他问题'}]}};
const issue=(ref='m',extra={})=>({ref,type:'critical',problem:'未验证不能写成未发生',impact:'误判实际发生的事',mustFix:true,fixable:true,...extra});
const start=()=>({raw:{},reviews:{m:{rev:0},u:{rev:0},company:{rev:0}}});
const repair=run=>async(c,action)=>({rev:(action.before[c.id]?.rev||0)+1,childRev:c.children?.map(id=>action.before[id]?.rev)});
test('two edits require three full checks; parents and company refresh with current children',async()=>{
 const run=start(),seen=[],saved=[];
 await runReviewQuality({run,input,skill,sources,check:async reviews=>{seen.push(structuredClone(reviews));return reviews.m.rev<2?[issue()]:[];},revise:repair(run),save:async r=>saved.push(structuredClone(r))});
 assert.equal(run.quality.status,'passed');assert.equal(seen.length,3);assert.deepEqual(seen.map(r=>r.m.rev),[0,1,2]);
 assert.deepEqual(run.quality.counts,{m:2,u:2,company:2});assert.deepEqual(run.reviews.u.childRev,[2]);assert.deepEqual(run.reviews.company.childRev,[2]);assert.ok(saved.length>8);
});
test('persistent mandatory issues stop at two edits and block installation; resume cannot reset the budget',async()=>{
 const run=start(),args={run,input,skill,sources,check:async()=>[issue()],revise:repair(run)};
 await runReviewQuality(args);assert.equal(run.quality.status,'blocked');assert.equal(run.quality.counts.m,2);assert.equal(run.quality.passes.length,3);assert.ok(run.quality.remaining.length);
 await runReviewQuality(args);assert.equal(run.quality.counts.m,2);
 const file=reviewFile({...run,failed:[],dropped:[]},{...input,period:'2026-10'},{skill,model:'fixture',label:'draft'});
 assert.throws(()=>installReviewRound(createCollaborationState([]),file),/不能装入/);
});
test('structure and semantics consume the same per-card budget, including newly introduced errors',async()=>{
 const run=start();
 await runReviewQuality({run,input,skill,sources,check:async reviews=>reviews.m.rev===1?[issue()]:[],problems:r=>r.reviews.m.rev===0?[{unit:'m',problem:'结构缺字段'}]:[],revise:repair(run)});
 assert.equal(run.quality.status,'passed');assert.equal(run.quality.counts.m,2);assert.equal(run.quality.passes[0].structural.length,1);assert.equal(run.quality.passes[1].issues.length,1);
});
test('the limit is per card, not a shared two-edits limit for an entire batch',async()=>{
 const run={raw:{},reviews:{a:{rev:0},b:{rev:0}}},input={stages:[[{id:'a'},{id:'b'}],[],[]]};
 await runReviewQuality({run,input,skill,sources,check:async r=>!r.a.rev?[issue('a')]:!r.b.rev?[issue('b')]:[],revise:repair(run)});
 assert.equal(run.quality.status,'passed');assert.deepEqual(run.quality.counts,{a:1,b:1});
});
test('unfixable mandatory gaps remain blocked rather than being silently labelled clean',async()=>{
 const run=start();let edits=0;
 await runReviewQuality({run,input,skill,sources,check:async()=>[issue('m',{fixable:false})],revise:async()=>{edits++;}});
 assert.equal(run.quality.status,'blocked');assert.equal(edits,0);assert.equal(run.issues[0].fixable,false);
});
test('resume after a partial parent refresh preserves completed edits, frozen requests and reserved budgets',async()=>{
 let run=start(),fail=true;const calls=[];
 const args=()=>({run,input,skill,sources,check:async r=>r.m.rev===0?[issue()]:[],revise:async(c,a)=>{calls.push(c.id);if(c.id==='u'&&fail)throw Error('model unavailable');return repair(run)(c,a);}});
 await assert.rejects(runReviewQuality(args()),/unavailable/);assert.equal(run.quality.status,'waiting');assert.equal(run.reviews.m.rev,1);assert.equal(run.quality.counts.u,1);
 run=JSON.parse(JSON.stringify(run));fail=false;await runReviewQuality(args());
 assert.equal(run.quality.status,'passed');assert.equal(calls.filter(x=>x==='m').length,1);assert.deepEqual(run.quality.counts,{m:1,u:1,company:1});assert.equal(run.reviews.u.childRev[0],1);
});
test('source, skill and candidate changes cannot reuse a quality checkpoint',async()=>{
 const run=start();await runReviewQuality({run,input,skill,sources,check:async()=>[],revise:repair(run)});
 for(const changes of [{sources:{m:'changed'}},{skill:{...skill,hash:'changed'}},{input:{...input,period:'changed'}}])await assert.rejects(runReviewQuality({run,input,skill,sources,check:async()=>[],revise:repair(run),...changes}),/已变化/);
 run.reviews.m.rev=99;await assert.rejects(runReviewQuality({run,input,skill,sources,check:async()=>[],revise:repair(run)}),/候选已变化/);
});
test('model call cache is keyed by current candidate and pass; all attempts retain full original evidence',async()=>{
 const quality={requests:{},sourceHash:'source',skillHash:'skill'},run={raw:{}},payload={sources,candidateHash:'before'},calls=[];
 const args={quality,run,pass:0,stage:'check',payload,system:'rules',save:async()=>{},gateway:{complete:async messages=>{calls.push(JSON.parse(messages[1].content));return {answer:'{"issues":[]}'};}}};
 const validate=x=>{assert.ok(Array.isArray(x.issues));return x;};
 await qualityModelCall({...args,validate});await qualityModelCall({...args,validate});assert.equal(calls.length,1);
 await qualityModelCall({...args,pass:1,payload:{...payload,candidateHash:'after'},validate});assert.equal(calls.length,2);assert.equal(calls[1].sources.m.evidence[0].text,'真实会议验证仍待实会');assert.equal(Object.keys(quality.requests).length,2);
});
test('failed checkers are not zero issues; malformed raw is retained and a resume can fetch a valid answer',async()=>{
 const quality={requests:{},sourceHash:'s',skillHash:'h'},run={raw:{}},args={quality,run,pass:0,stage:'check',payload:{sources},system:'rules',save:async()=>{},validate:x=>{if(!Array.isArray(x.issues))throw Error('no issues');return x;}};
 let calls=0,bad=true;const gateway={complete:async()=>{calls++;return {answer:bad?'{}':'{"issues":[]}'};}};
 await assert.rejects(qualityModelCall({...args,gateway}),/no issues/);assert.equal(calls,3);assert.equal(Object.values(quality.requests)[0].attempts[0].raw,'{}');assert.equal(Object.keys(run.raw).length,0);
 bad=false;await qualityModelCall({...args,gateway});assert.equal(calls,4);assert.equal(Object.values(quality.requests)[0].attempts.length,4);
});
test('cancellation interrupts a call without adding transport retries',async()=>{
 const controller=new AbortController();let calls=0;
 const gateway={complete:async(_messages,{signal})=>{calls++;controller.abort(Error('cancelled'));signal.throwIfAborted();}};
 await assert.rejects(qualityModelCall({gateway,quality:{requests:{}},run:{raw:{}},pass:0,stage:'check',payload:{},system:'rules',save:async()=>{},signal:controller.signal}),/cancelled/);assert.equal(calls,1);
});
test('product skill exposes an exact two-round contract',async()=>{
 const actual=await loadReviewSkill(new URL('./review-skill/',import.meta.url));assert.equal(actual.version,'2.1.13');assert.equal(actual.maxRevisionRounds,2);assert.equal(actual.groups.length,3);
});
test('product runner checks after both repairs, preserves complete E43/E49 sources and never restores initial cached drafts on resume',async()=>{
 const basis={mode:'latest-source-candidate',snapshotHash:'snapshot'},meta={basisMode:basis.mode,snapshotHash:basis.snapshotHash};
 const c=(id,level,parent,children)=>({id,unit:id==='company'?'company':'u',title:id,owner:'陈溪南',level,parent,children,sourceBasis:meta,childCommitments:{...meta,complete:true,items:[]},evidence:id==='m'?[...sources.m.evidence,{id:'E50',text:'x'.repeat(500)+'快嘴'}]:[],...(id==='m'?{expectedFacts:[{ref:'t',item:'成果'}]}:{})});
 const input={basis,stages:[[c('m','mission','u',[])],[c('u','ru','company',['m'])],[c('company','company',null,['u'])]]};
 const actual={...skill,version:'2.1.13',rules:'原来源优先',groups:[1,2,3].map(()=>({name:'关键事实',types:['critical']}))};
 const calls=[],run={raw:{},reviews:{},failed:[],dropped:[]};
 const review=(id,reason='initial')=>({verdict:'未达成',verdictReason:reason,facts:[{ref:{m:'t',u:'m',company:'u'}[id],item:'成果',status:'未达成',evidence:'尚缺验证记录',gap:'尚缺验证记录'}],nextInputs:[{ref:{m:'t',u:'m',company:'u'}[id],type:'继续',text:'核对结果'}]});
 const gateway={complete:async messages=>{const p=JSON.parse(messages[1].content);calls.push(p);
  if(!p.unit){assert.ok(p.sources.m.evidence[2].text.endsWith('快嘴'));assert.ok(p.sources.m.evidence[2].text.length>400);assert.equal(p.sources.m.evidence[0].text,'真实会议验证仍待实会');const m=p.reviews.find(r=>r.ref==='m');return {answer:JSON.stringify({checkedRefs:p.scope.targetRefs,checkedEdges:p.scope.edges,sourceRequests:[],issues:m.verdictReason==='fixed2'?[]:[issue()]})};}
  return {answer:JSON.stringify({review:review(p.unit.id,p.revision?'fixed'+p.revision:'initial')})};
 }};
 const args={gateway,skill:actual,input,run,programOptions:{childRule:false}};
 await runReviewSkill(args);assert.equal(run.quality.status,'passed');assert.equal(run.reviews.m.verdictReason,'fixed2');assert.deepEqual(run.quality.counts,{m:2,u:2,company:2});assert.equal(calls.filter(p=>!p.unit).length,9);
 const before=calls.length;await runReviewSkill(args);assert.equal(calls.length,before);assert.equal(run.reviews.m.verdictReason,'fixed2');
});

test('cancellation at the last checker response cannot mark the candidate passed',async()=>{
 const run=start(),controller=new AbortController();
 await assert.rejects(runReviewQuality({run,input,skill,sources,signal:controller.signal,check:async()=>{controller.abort(Error('cancel at final response'));return [];},revise:repair(run)}),/cancel at final response/);
 assert.equal(run.quality.status,'waiting');assert.notEqual(run.quality.status,'passed');
});

test('stored request payload is verified on failed resume and completed cache reuse before any gateway call',async()=>{
 for(const done of [false,true]){
  const quality={requests:{},sourceHash:'frozen',skillHash:'skill'},run={raw:{}},args={quality,run,pass:0,stage:'check',payload:{sources},system:'rules',save:async()=>{}};
  if(done)await qualityModelCall({...args,gateway:{complete:async()=>({answer:'{"issues":[]}'})}});else await assert.rejects(qualityModelCall({...args,gateway:{complete:async()=>{throw Error('offline');}}}));
  Object.values(quality.requests)[0].payload.sources.m.evidence[0].text='伪造：从未用过';let calls=0;
  await assert.rejects(qualityModelCall({...args,gateway:{complete:async()=>{calls++;return {answer:'{"issues":[]}'};}}}),/请求已变化/);assert.equal(calls,0);
 }
});
test('pending before, completed after, check snapshots, diagnostics and reserved counts are validated before reuse',async()=>{
 const broken=start();await assert.rejects(runReviewQuality({run:broken,input,skill,sources,check:async()=>[issue()],revise:async(c,a)=>{if(c.id==='u')throw Error('pause');return repair(broken)(c,a);}}),/pause/);
 for(const change of [
  r=>{r.quality.passes[0].actions[1].before.m.rev=100;},
  r=>{const a=r.quality.passes[0].actions[1];a.before.m.rev=100;a.beforeHash=qualityHash(a.before);},
  r=>{r.quality.passes[0].actions[0].afterHash='wrong';},
  r=>{r.quality.passes[0].reviews.m.rev=100;},
  r=>{r.quality.passes[0].actions[1].issues.push(issue());},
  r=>{r.quality.counts.m=0;},
  r=>{r.quality.passes[0].actions[0].reserved=false;delete r.quality.counts.m;},
 ]){
  const run=structuredClone(broken);change(run);let calls=0;
  await assert.rejects(runReviewQuality({run,input,skill,sources,check:async()=>{calls++;return [];},revise:async()=>{calls++;return {};}}),/校验失败/);assert.equal(calls,0);
 }
});

test('quality answer caches remain separate for the two explicit test models',async()=>{
 const quality={requests:{},sourceHash:'frozen',skillHash:'skill'},run={raw:{}},args={quality,run,pass:0,stage:'check',payload:{sources},system:'rules',save:async()=>{}};let calls=0;
 for(const model of ['aliyun/deepseek-v4.1-flash','wangsu/claude-sonnet-5-5'])await qualityModelCall({...args,gateway:{status:{model},complete:async()=>{calls++;return {answer:'{"issues":[]}'};}}});
 assert.equal(calls,2);assert.equal(Object.keys(quality.requests).length,2);
});
