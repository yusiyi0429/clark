import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewQuestionRoutes,routeReviewQuestions,activeReviewAsk} from './review-question-routing.mjs';
import {askLoad,askedBelow} from './review-generation.mjs';
import {qualityHash} from './review-quality.mjs';
import {reviewCards} from './review-round.mjs';
import {canRead} from './governance.mjs';
const fixture=()=>({m:{ref:'m',level:'mission',unit:'u',nextInputs:[{ref:'t',type:'继续',text:'原文必须保留',ask:{to:'甲',question:'原来的问题？'}}]},u:{ref:'u',unit:'u',level:'ru',nextInputs:[{ref:'m',type:'继续',text:'上层同一件事',ask:{to:'甲',question:'统一回答？'},covers:[{ref:'m',index:0},{ref:'m',index:0}]}]}});
test('routing is lossless and idempotent; one active question, no lower duplicate permission or obligation',()=>{
 const reviews=fixture(),before=qualityHash(reviews),routes=reviewQuestionRoutes(reviews),projection=routeReviewQuestions(reviews);
 assert.equal(routes.length,1);assert.deepEqual(reviewQuestionRoutes(reviews),routes);assert.equal(qualityHash(reviews),before);
 assert.equal(projection.m.nextInputs[0].text,'原文必须保留');assert.equal(projection.m.nextInputs[0].ask.question,'原来的问题？');assert.equal(activeReviewAsk(projection.m.nextInputs[0]),null);
 assert.deepEqual(askLoad(Object.values(reviews)),[{name:'甲',count:1}]);assert.deepEqual(askedBelow({reviews}).map(x=>x.ref),['u']);
 const cards=reviewCards({reviews}),actor={name:'甲',visibleUnits:[]};assert.equal(canRead(actor,cards['rv:m']),false);assert.equal(canRead(actor,cards['rv:u']),true);assert.equal(qualityHash(reviews),before);
 projection.m.nextInputs[0].text='后来新问题';assert.ok(activeReviewAsk(projection.m.nextInputs[0]),'changed lower content invalidates old route');
});
test('invalid cover refs, same-level covers and a target with no active question cannot suppress an ask',()=>{
 const reviews=fixture();reviews.u.nextInputs[0].ask=null;assert.deepEqual(reviewQuestionRoutes(reviews),[]);reviews.u.nextInputs[0].ask={to:'甲',question:'x'};reviews.u.level='mission';assert.deepEqual(reviewQuestionRoutes(reviews),[]);
});
