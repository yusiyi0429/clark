import {test} from 'node:test';import assert from 'node:assert/strict';
import {m2Fetch} from './deployment-client.mjs';
import {getPageConfirmation,subscribePageConfirmation,cancelPageConfirmation} from './page-confirmation.mjs';
const requests=[
 {memberId:'member-03',action:{type:'revise',cardId:'x',baseVersion:1,patch:{result:'新成果'}}},
 {memberId:'member-03',action:{type:'acceptProposal',proposalId:'p',cardId:'x',baseVersion:1}},
 {memberId:'member-03',token:'preview-token'},
 {memberId:'member-03',action:{type:'message',cardId:'person:member-03',text:'确认',replyTo:'p'}}
];
test('四入口取消不重试，继续只携原身份/内容/服务端凭证重试一次',async()=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;
 globalThis.window={confirm:()=>{throw Error('禁止原生弹窗');}};
 try{for(const request of requests)for(const answer of [false,true]){
  const sent=[],stop=subscribePageConfirmation(()=>{const current=getPageConfirmation();if(current){assert.match(current.message,/已确认.*重新确认.*继续/);queueMicrotask(()=>current.choose(answer));}});
  globalThis.fetch=async(url,options)=>{sent.push({url,body:JSON.parse(options.body),headers:new Headers(options.headers)});return sent.length===1?new Response(JSON.stringify({code:'RECONFIRM_REQUIRED',reconfirmToken:'bound-token'}),{status:409}):new Response(JSON.stringify({ok:true}),{status:200});};
  try{const endpoint=request.token?'/api/markdown/apply':'/api/actions';const call=m2Fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Custom':'preserved'},body:JSON.stringify(request)});
   if(answer){assert.equal((await call).status,200);assert.equal(sent.length,2);assert.deepEqual(sent[1].body,{...request,ackToken:'bound-token'});assert.equal(sent[1].headers.get('X-M2-Expected-Member'),request.memberId);assert.equal(sent[1].headers.get('X-Custom'),'preserved');assert.equal(sent[1].url,'/m2'+endpoint);}
   else{await assert.rejects(call,e=>e.code==='CANCELLED');assert.equal(sent.length,1);}
  }finally{stop();}
 }}finally{globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});
test('原请求在等待期间不被改写，凭证重试再次冲突不重新弹窗',async()=>{
 const oldFetch=globalThis.fetch;let prompts=0;const sent=[];
 const options={method:'POST',headers:{'X-Custom':'old'},body:JSON.stringify(requests[0])};
 const stop=subscribePageConfirmation(()=>{const current=getPageConfirmation();if(!current)return;prompts++;options.body=JSON.stringify(requests[1]);options.headers['X-Custom']='new';queueMicrotask(()=>current.choose(true));});
 globalThis.fetch=async(url,opts)=>{sent.push({body:JSON.parse(opts.body),header:new Headers(opts.headers).get('X-Custom')});return new Response(JSON.stringify({code:'RECONFIRM_REQUIRED',reconfirmToken:'token'}),{status:409});};
 try{assert.equal((await m2Fetch('/api/actions',options)).status,409);assert.equal(prompts,1);assert.equal(sent.length,2);assert.deepEqual(sent[1].body,{...requests[0],ackToken:'token'});assert.equal(sent[1].header,'old');}finally{stop();globalThis.fetch=oldFetch;}
});
test('等待确认时请求被取消，不发送凭证重试',async()=>{
 const oldFetch=globalThis.fetch,controller=new AbortController();let count=0;
 const stop=subscribePageConfirmation(()=>{if(getPageConfirmation())queueMicrotask(()=>controller.abort());});
 globalThis.fetch=async()=>{count++;return new Response(JSON.stringify({code:'RECONFIRM_REQUIRED',reconfirmToken:'token'}),{status:409});};
 try{await assert.rejects(m2Fetch('/api/actions',{method:'POST',signal:controller.signal,body:JSON.stringify(requests[0])}),e=>e.code==='CANCELLED');assert.equal(count,1);}finally{cancelPageConfirmation();stop();globalThis.fetch=oldFetch;}
});
