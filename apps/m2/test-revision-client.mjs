import {test} from 'node:test';import assert from 'node:assert/strict';
import {m2Fetch} from './deployment-client.mjs';
test('已确认卡取消时仅首个请求，继续时发送服务端凭证，原请求/身份保留',async()=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;
 try{for(const answer of [false,true]){const sent=[];globalThis.window={confirm:text=>{assert.match(text,/已确认.*重新确认.*继续/);return answer;}};globalThis.fetch=async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return sent.length===1?new Response(JSON.stringify({code:'RECONFIRM_REQUIRED',reconfirmToken:'bound-token'}),{status:409}):new Response(JSON.stringify({ok:true}),{status:200});};const request={memberId:'member-03',action:{type:'revise',cardId:'x',baseVersion:1,patch:{result:'新成果'}}};const call=()=>m2Fetch('/api/actions',{method:'POST',body:JSON.stringify(request)});if(answer){assert.equal((await call()).status,200);assert.equal(sent.length,2);assert.deepEqual(sent[1].body,{...request,ackToken:'bound-token'});}else{await assert.rejects(call(),e=>e.code==='CANCELLED');assert.equal(sent.length,1);}}}finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});
