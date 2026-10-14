import test from 'node:test';
import assert from 'node:assert/strict';
import {retryRoundCall,parseRoundJSON} from './round-retry.mjs';
test('限流和临时错误最多三次，退避；权限与资料错误不盲目重试',async()=>{
 let calls=0;const delays=[],notices=[];
 const result=await retryRoundCall(()=>{if(++calls<3)throw Object.assign(Error('限流'),{providerStatus:429});return 'ok';},{sleep:async ms=>delays.push(ms),onRetry:async x=>notices.push(x)});
 assert.equal(result,'ok');assert.deepEqual(delays,[1000,2000]);assert.equal(notices.length,2);
 calls=0;await assert.rejects(()=>retryRoundCall(()=>{calls++;throw Object.assign(Error('鉴权失败'),{providerStatus:401});},{sleep:async()=>{}}),/鉴权/);assert.equal(calls,1);
 calls=0;await assert.rejects(()=>retryRoundCall(()=>{calls++;throw Object.assign(Error('故障'),{providerStatus:503});},{sleep:async()=>{}}),/故障/);assert.equal(calls,3);
});
test('审核缺结构、格式错不算完成，明确缺口可以作为审核结果',()=>{
 for(const value of ['{','{}','[]','null','{"issues":[{}],"gaps":[]}'])assert.throws(()=>parseRoundJSON(value,{audit:true}),/格式|字段|问题/);
 assert.deepEqual(parseRoundJSON('{"issues":[],"gaps":["客户窗口未知"]}',{audit:true}).gaps,['客户窗口未知']);
});
