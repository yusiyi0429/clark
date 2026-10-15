import test from 'node:test';
import assert from 'node:assert/strict';
import {retryRoundCall,parseRoundJSON,retryDelayMs} from './round-retry.mjs';
test('限流退避更长，其他临时错误最多三次；权限与资料错误不盲目重试',async()=>{
 let calls=0;const delays=[],notices=[];
 const result=await retryRoundCall(()=>{if(++calls<3)throw Object.assign(Error('限流'),{providerStatus:429});return 'ok';},{sleep:async ms=>delays.push(ms),onRetry:async x=>notices.push(x)});
 assert.equal(result,'ok');assert.deepEqual(delays,[5000,15000]);assert.equal(notices.length,2);
 calls=0;await assert.rejects(()=>retryRoundCall(()=>{calls++;throw Object.assign(Error('鉴权失败'),{providerStatus:401});},{sleep:async()=>{}}),/鉴权/);assert.equal(calls,1);
 calls=0;await assert.rejects(()=>retryRoundCall(()=>{calls++;throw Object.assign(Error('故障'),{providerStatus:503});},{sleep:async()=>{}}),/故障/);assert.equal(calls,3);
});
test('审核缺结构、格式错不算完成，明确缺口可以作为审核结果',()=>{
 for(const value of ['{','{}','[]','null','{"issues":[{}],"gaps":[]}'])assert.throws(()=>parseRoundJSON(value,{audit:true}),/格式|字段|问题/);
 assert.deepEqual(parseRoundJSON('{"issues":[],"gaps":["客户窗口未知"]}',{audit:true}).gaps,['客户窗口未知']);
});
test('限流最多五次并遵守 Retry-After，上限一分钟',async()=>{
 let calls=0;const delays=[];
 await assert.rejects(()=>retryRoundCall(()=>{calls++;throw Object.assign(Error('限流'),{providerStatus:429});},{sleep:async ms=>delays.push(ms)}),/限流/);
 assert.equal(calls,5);assert.deepEqual(delays,[5000,15000,45000,60000]);
 assert.equal(retryDelayMs({providerStatus:429,retryAfterMs:7000},1),7000);
 assert.equal(retryDelayMs({providerStatus:429,retryAfterMs:600000},1),60000);
 assert.equal(retryDelayMs({providerStatus:503},2),2000);
});
test('模型流中途被断开（terminated）按临时错误重试',async()=>{
 let calls=0;const result=await retryRoundCall(()=>{if(++calls<2)throw new TypeError('terminated',{cause:Object.assign(Error('other side closed'),{code:'UND_ERR_SOCKET'})});return 'ok';},{sleep:async()=>{}});
 assert.equal(result,'ok');assert.equal(calls,2);
});
