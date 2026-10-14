import test from 'node:test';
import assert from 'node:assert/strict';
import {nexusRetry} from './nexus-retry.mjs';
test('Transient failures retry with a bounded increasing backoff',()=>{
 assert.deepEqual([0,1,2].map(n=>nexusRetry(502,n).delay),[2000,8000,20000]);
 assert.equal(nexusRetry(503,3).retry,false);assert.equal(nexusRetry(429,0).retry,true);
 for(const code of [400,401,403,404])assert.equal(nexusRetry(code).retry,false);
 assert.deepEqual(nexusRetry(409,2),{retry:true,delay:1000,count:2});
});
