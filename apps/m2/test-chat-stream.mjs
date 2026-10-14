import test from 'node:test';
import assert from 'node:assert/strict';
import {readChatStream} from './chat-stream.mjs';
import {createModelGateway} from './model.mjs';
test('聊天流逐段接收中文、忽略思考状态，只在完成事件成功',async()=>{
 let release;
 const encoder=new TextEncoder(),texts=[];
 const body=new ReadableStream({start(c){c.enqueue(encoder.encode('{"type":"thinking"}\n{"type":"text","text":"第一段"}\n'));release=()=>{c.enqueue(encoder.encode('{"type":"text","text":"第一段第二段"}\n{"type":"done","answer":"完整回答"}\n'));c.close();};}});
 const promise=readChatStream(new Response(body,{headers:{'Content-Type':'application/x-ndjson'}}),t=>texts.push(t));
 await new Promise(r=>setTimeout(r,5));assert.deepEqual(texts,['第一段']);release();assert.equal((await promise).answer,'完整回答');assert.equal(texts.at(-1),'完整回答');
});
test('聊天流中断或服务端报错不能视为完整消息',async()=>{
 for(const content of ['{"type":"text","text":"不完整"}\n','{"type":"error","error":"材料已更新"}\n'])await assert.rejects(()=>readChatStream(new Response(content,{headers:{'Content-Type':'application/x-ndjson'}}),()=>{}),/中断|材料已更新/);
});
test('模型正文实时转发，内部思考不泄漏；输出额度留给最高思考',async()=>{
 const events=[{choices:[{delta:{reasoning_content:'private-thought'},finish_reason:null}]},{choices:[{delta:{content:'第一段'},finish_reason:null}]},{choices:[{delta:{content:'第二段'},finish_reason:'stop'}]}];
 let sent;const seen=[];
 const gateway=await createModelGateway({env:{TOKENHUB_API_KEY:'test-only'},transport:async(_url,o)=>{sent=JSON.parse(o.body);return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});}});
 const result=await gateway.complete([],{onDelta:t=>seen.push(t)});assert.deepEqual(seen,['第一段','第二段']);assert.equal(result.answer,'第一段第二段');assert.equal(sent.reasoning_effort,'high');assert.equal(sent.enable_thinking,true);assert.equal(sent.max_tokens,65536);
});
