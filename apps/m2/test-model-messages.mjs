import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createModelGateway,bareJson} from './model.mjs';
const sse=events=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));c.close();}}),{status:200,headers:{'content-type':'text/event-stream'}});
const env={DECODING_MODEL:'wangsu/claude-sonnet-5-5',DECODING_API_KEY:'test-key'};
test('Claude 走 Messages 接口：系统提示单列、流式拼出答案、思考用 adaptive',async()=>{
 let sent,url;const deltas=[];
 const g=await createModelGateway({env,transport:async(u,init)=>{url=String(u);sent=JSON.parse(init.body);return sse([{type:'message_start',message:{id:'msg_1',model:'claude-provider-canonical',usage:{input_tokens:12}}},{type:'content_block_delta',delta:{type:'text_delta',text:'```json\n{"a":'}},{type:'content_block_delta',delta:{type:'text_delta',text:'1}\n```'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:5}}]);}});
 const r=await g.complete([{role:'system',content:'你是 Nexus'},{role:'user',content:'整理'}],{json:true,thinking:true,reasoningEffort:'high',onDelta:d=>deltas.push(d)});
 assert.equal(r.requestedAlias,env.DECODING_MODEL);assert.equal(r.returnedModel,'claude-provider-canonical');
 assert.equal(url,'https://tokenhub.corp.tokenkingos.com/api/anthropic/v1/messages');
 assert.match(sent.system,/你是 Nexus/);assert.deepEqual(sent.messages,[{role:'user',content:'整理'}]);
 assert.deepEqual(sent.thinking,{type:'adaptive',display:'summarized'});assert.equal(sent.output_config.effort,'high');assert.equal(sent.stream,true);
 assert.equal(r.answer,'{"a":1}');assert.equal(deltas.length,2);assert.equal(r.usage.completion_tokens,5);
});
test('Claude 输出被截断时不应用',async()=>{
 const g=await createModelGateway({env,transport:async()=>sse([{type:'message_start',message:{id:'m'}},{type:'content_block_delta',delta:{type:'text_delta',text:'半句'}},{type:'message_delta',delta:{stop_reason:'max_tokens'}}])});
 await assert.rejects(g.complete([{role:'user',content:'x'}]),/不完整/);
 assert.equal(bareJson('好的：{"x":[1]} 以上'),'{"x":[1]}');
});
test('模型拒答单独报 MODEL_REFUSAL；聊天网关发出前隐去敏感个人细节',async()=>{
 const refused=await createModelGateway({env:{...env,DECODING_STREAM_LOG:'/dev/null'},transport:async()=>sse([{type:'message_start',message:{id:'msg_r',usage:{input_tokens:9}}},{type:'message_delta',delta:{stop_reason:'refusal'},usage:{output_tokens:0}}])});
 await assert.rejects(refused.complete([{role:'user',content:'复盘'}],{thinking:true}),e=>e.code==='MODEL_REFUSAL'&&e.diagnostics.finishReason==='refusal');
 let sent;const chat=await createModelGateway({env,redact:true,transport:async(u,init)=>{sent=JSON.parse(init.body);return sse([{type:'message_start',message:{id:'m'}},{type:'content_block_delta',delta:{type:'text_delta',text:'好'}},{type:'message_delta',delta:{stop_reason:'end_turn'}}]);}});
 await chat.complete([{role:'user',content:'Harness 候选人谈薪差 20%，背调结果为绿灯。背调还没回。股权激励方案已形成框架。'}]);
 assert.equal(sent.messages[0].content,'〔已隐去：薪酬细节〕，〔已隐去：背调细节〕。背调还没回。股权激励方案已形成框架。');
});
