import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewQuestionRoutes,routeReviewQuestions,activeReviewAsk} from './review-question-routing.mjs';
import {askLoad,askedBelow} from './review-generation.mjs';
import {qualityHash} from './review-quality.mjs';
import {reviewCards} from './review-round.mjs';
import {canRead,applyAction,createCollaborationState,currentVersion} from './governance.mjs';
import {sharedProjection} from './shared-projection.mjs';
import {reviewTodos} from './review-display.mjs';
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

test('removing a cover from an already routed projection clears stale markers without changing its question',()=>{
 const first=routeReviewQuestions(fixture());first.u.nextInputs[0].covers=[];
 const next=routeReviewQuestions(first);assert.equal(next.m.nextInputs[0].questionRoute,undefined);assert.equal(activeReviewAsk(next.m.nextInputs[0]).question,'原来的问题？');assert.equal(next.m.nextInputs[0].text,'原文必须保留');
 assert.deepEqual(routeReviewQuestions(next),next);assert.deepEqual(askLoad(Object.values(next)),[{name:'甲',count:2}]);
 // Retargeting the upper row must not continue suppressing the old lower row.
 next.u.nextInputs[0].covers=[{ref:'missing',index:0}];assert.ok(activeReviewAsk(routeReviewQuestions(next).m.nextInputs[0]));
});

test('accepted upper revisions recompute live permissions, visible asks and todos without rewriting lower versions',()=>{
 const reviews=fixture();for(const r of Object.values(reviews)){r.facts=[];r.verdict='未达成';for(const n of r.nextInputs)n.ask.to='于斯一';}
 reviews.m.owner='陈溪南';reviews.u.owner='刘明华';
 let state={...createCollaborationState([]),cards:reviewCards({reviews})};
 const actor={id:'member-06',name:'于斯一',visibleUnits:[],unitDri:[],missionDri:[]},ceo={id:'member-01',name:'刘明华',ceo:true,visibleUnits:[],unitDri:['u']};
 const lowerBefore=qualityHash(state.cards['rv:m'].versions),originalBefore=qualityHash(reviews);
 assert.ok(currentVersion(state.cards['rv:u']).content.nextInputs[0].covers.length);assert.equal(canRead(actor,state.cards['rv:m'],state),false);
 let view=sharedProjection(state,actor);assert.equal(view.drafts['rv:m'],undefined);assert.equal(reviewTodos(Object.values(view.drafts),actor).filter(x=>x.kind==='ask').length,1);
 const oldRow=currentVersion(state.cards['rv:u']).content.nextInputs[0];state=applyAction(state,ceo,{type:'revise',cardId:'rv:u',baseVersion:1,patch:{nextInputs:[{...oldRow,covers:[]}]}});
 assert.equal(canRead(actor,state.cards['rv:m'],state),true);const beforeRead=qualityHash(state);view=sharedProjection(state,actor);assert.equal(qualityHash(state),beforeRead);
 assert.equal(view.drafts['rv:m'].nextInputs[0].questionRoute,undefined);assert.equal(activeReviewAsk(view.drafts['rv:m'].nextInputs[0]).question,'原来的问题？');assert.equal(reviewTodos(Object.values(view.drafts),actor).filter(x=>x.kind==='ask').length,2);
 assert.equal(qualityHash(state.cards['rv:m'].versions),lowerBefore);assert.equal(qualityHash(reviews),originalBefore);
 state=applyAction(state,ceo,{type:'revise',cardId:'rv:u',baseVersion:2,patch:{nextInputs:[oldRow]}});assert.equal(canRead(actor,state.cards['rv:m'],state),false);
 // A later lower edit is a new question; an old cover cannot silently take it over.
 state.cards['rv:m'].versions.at(-1).content.nextInputs[0].text='新问题正文';const fresh=sharedProjection(state,actor);assert.ok(activeReviewAsk(fresh.drafts['rv:m'].nextInputs[0]));
});
