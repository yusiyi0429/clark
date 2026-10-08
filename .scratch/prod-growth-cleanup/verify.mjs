import assert from 'node:assert/strict';
import pg from 'pg';
import { listBattlefieldRows } from './src/battlefields.ts';
import { getMonthlyPlanRow, projectMonthlyPlanCard } from './src/monthlyPlans.ts';
import { getMonthlyReviewRow, getMonthlyReviewItem, listMonthlyReviewItems, projectMonthlyReview } from './src/monthlyReviews.ts';

const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c default_transaction_read_only=on'});
const client=await pool.connect();
try {
 await client.query('BEGIN READ ONLY');
 const query=client.query.bind(client);
 const battlefields=await listBattlefieldRows(query);
 assert.deepEqual(battlefields.map(b=>b.id),['灯塔项目','token-ops','002-客户']);
 const plan=await getMonthlyPlanRow(query,'d5a09015-4e30-4979-926c-c3bc08c5d55a');
 const planCard=projectMonthlyPlanCard(plan,'data-cleanup-read-check-only');
 assert.equal(planCard.version,9);
 assert.equal(planCard.payload.companyOutcome,'');
 assert.equal(planCard.payload.battlefields.length,0);
 assert.equal(planCard.payload.generation.status,'failed');
 assert(planCard.actions.some(a=>a.actionType.includes('retry')));
 assert.equal(await getMonthlyReviewItem(query,'ae781b21-3bea-4091-bf0b-ffae5fd1cc92'),null);
 const review=await getMonthlyReviewRow(query,'6807d697-478b-49d7-adc2-1fce826ab737');
 const items=await listMonthlyReviewItems(query,review.id);
 const overview=projectMonthlyReview(review,items,new Map(),'','data-cleanup-read-check-only');
 assert.equal(overview.counts.total,10);
 assert(items.every(i=>i.subject_id!=='growth'));
 const health=await (await fetch('http://127.0.0.1:4000/api/healthz')).json();
 assert.equal(health.status,'ok');assert.equal(health.database,true);
 await client.query('ROLLBACK');
 console.log(JSON.stringify({passed:true,source:'running production API projectors',battlefields:battlefields.map(b=>b.name),planRetryAvailable:true,removedReviewItemNotFound:true,reviewItems:overview.counts.total,health:health.status}));
}finally{client.release();await pool.end();}
