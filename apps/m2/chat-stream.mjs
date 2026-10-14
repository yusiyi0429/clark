// Only completed answers may replace the transient stream preview.
export async function readChatStream(response,onText){
 if(!response.ok){const value=await response.json();throw Error(value.error||'聊天请求失败');}
 if(!response.headers.get('content-type')?.includes('application/x-ndjson'))return response.json();
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',done;
 const consume=line=>{if(!line.trim())return;const event=JSON.parse(line);if(event.type==='error')throw Error(event.error);if(event.type==='text')onText(event.text);if(event.type==='done'){done=event;onText(event.answer);}};
 try{while(true){const chunk=await reader.read();pending+=decoder.decode(chunk.value,{stream:!chunk.done});let i;while((i=pending.indexOf('\n'))>=0){consume(pending.slice(0,i));pending=pending.slice(i+1);}if(chunk.done)break;}if(pending.trim())consume(pending);if(!done)throw Error('回答中断，未保存为完整消息，请重试');return done;}finally{await reader.cancel().catch(()=>{});}
}
