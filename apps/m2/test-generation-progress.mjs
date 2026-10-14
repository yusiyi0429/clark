import test from 'node:test';
import assert from 'node:assert/strict';
import {generationProgress} from './generation-progress.mjs';
test('预估进度按真实阶段设上限，等待时长按任务开始时间，不冒充完成',()=>{
 const start=Date.parse('2026-10-13T00:00:00Z');
 const job={createdAt:new Date(start).toISOString(),stage:'生成全局 PO 草图'};
 const first=generationProgress(job,start,start),later=generationProgress(job,start+600000,start);
 assert.ok(later.percent>first.percent);assert.ok(later.percent<=24);assert.equal(later.wait,'10分00秒');
 assert.ok(generationProgress({...job,stage:'并行细化 Mission 与 Task',done:5,total:10},start,start).percent>later.percent);
 assert.equal(generationProgress({...job,stage:'复核修订后的整轮候选'},start+99999999,start).percent,99);
 assert.equal(generationProgress({stage:'读取本体'},start,start).elapsed,0);
});
