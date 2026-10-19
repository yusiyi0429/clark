import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// Decoding Skill 2026-10-19: a Messages stream that breaks off is recorded so TokenHub can trace it.
test('Messages 流没收到 message_stop 就断：记下请求号、秒数、字节数和最后的事件',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'stream-break-'));process.env.DECODING_STREAM_LOG=join(dir,'breaks.jsonl');
 const {createModelGateway}=await import('./model.mjs?break');
 const events=[{type:'message_start',message:{id:'msg_9'}},{type:'content_block_start'},{type:'content_block_delta',delta:{type:'text_delta',text:'半'}},{type:'ping'}];
 const body=new ReadableStream({start(c){for(const e of events)c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));c.close();}});
 const g=await createModelGateway({env:{DECODING_MODEL:'wangsu/claude-sonnet-5-5',DECODING_API_KEY:'k'},transport:async()=>new Response(body,{status:200,headers:{'content-type':'text/event-stream','request-id':'req_abc'}})});
 await assert.rejects(g.complete([{role:'user',content:'x'}]),/提前结束/);
 const [line]=(await readFile(process.env.DECODING_STREAM_LOG,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(line.requestId,'req_abc');assert.equal(line.messageId,'msg_9');assert.ok(line.bytes>0);assert.equal(typeof line.seconds,'number');
 assert.deepEqual(line.lastEvents,['message_start','content_block_start','content_block_delta','ping']);assert.equal(line.reason,'ended without message_stop');
 await rm(dir,{recursive:true,force:true});delete process.env.DECODING_STREAM_LOG;
});
