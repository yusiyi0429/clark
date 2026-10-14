import test from 'node:test';
import assert from 'node:assert/strict';
import {runRoundPool} from './round-pool.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('一个领域完成立即补位，不等同组慢领域，最多两路',async()=>{
 const started=[],releases=new Map();let active=0,peak=0;
 const flight=runRoundPool([1,2,3,4],async id=>{
  started.push(id);peak=Math.max(peak,++active);
  await new Promise(resolve=>releases.set(id,resolve));active--;
 });
 assert.deepEqual(started,[1,2]);releases.get(2)();await tick();assert.deepEqual(started,[1,2,3]);
 releases.get(3)();await tick();assert.deepEqual(started,[1,2,3,4]);
 releases.get(4)();releases.get(1)();await flight;assert.equal(peak,2);
});
test('失败不再开新领域；等待在途领域保存后才返回失败',async()=>{
 let fail,finish,returned=false;const started=[],saved=[];
 const flight=runRoundPool([1,2,3],async id=>{
  started.push(id);
  if(id===1)await new Promise((_resolve,reject)=>fail=reject);
  else await new Promise(resolve=>finish=resolve);
  saved.push(id);
 });
 const checked=assert.rejects(flight,/test-failure/).then(()=>returned=true);
 fail(Error('test-failure'));await tick();assert.equal(returned,false);assert.deepEqual(started,[1,2]);
 finish();await checked;assert.deepEqual(saved,[2]);
});
test('支持三路但保持上限；非法并发不能启动任务',async()=>{
 let count=0;await runRoundPool([],()=>count++,3);assert.equal(count,0);
 for(const concurrency of [0,5,1.5])await assert.rejects(()=>runRoundPool([1],()=>count++,concurrency),/并发数/);
 let active=0,peak=0;await runRoundPool([1,2,3,4],async()=>{peak=Math.max(peak,++active);await tick();active--;},3);
 assert.equal(peak,3);
});
