import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generationView,visibleReaderViews} from './deployment-projection.mjs';
test('Generation progress does not expose raw input, partial drafts, rules or other-domain audit to members',()=>{
 const job={id:'r',status:'running',stage:'生成',input:{sources:[{title:'来源',content:'private foundation'}]},partialUnits:[{title:'other domain'}],skillSnapshot:{version:'1',hash:'hash',rules:'private rules'},result:{audit:{summary:'other domain'},input:{sources:[{title:'来源',content:'private foundation'}]}}};
 const publicView=generationView(job,{ceo:false});assert.equal(publicView.audit,undefined);assert.equal(publicView.canResume,false);assert.ok(!JSON.stringify(publicView).includes('private'));assert.ok(!JSON.stringify(publicView).includes('other domain'));
 assert.equal(generationView(job,{ceo:true}).audit.summary,'other domain');assert.equal(generationView(job,{ceo:true}).sources[0].content,undefined);
 const state={cards:{visible:{unit:'bf01'},hidden:{unit:'bf02'}}};assert.deepEqual(visibleReaderViews({visible:{title:'mine'},hidden:{title:'not mine'}},state,{visibleUnits:['bf01']}),{visible:{title:'mine'}});
});
