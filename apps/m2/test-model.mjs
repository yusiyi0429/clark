import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createModelGateway,TOKENHUB_BASE,TOKENHUB_MODEL} from './model.mjs';
import {selectDiscussion} from './conversation-context.mjs';
test('默认 TokenHub：服务端密钥只在 Header，文本和 JSON 使用同一模型',async()=>{
 let captured;const g=await createModelGateway({env:{ARK_API_KEY:'never-forward',ARK_MODEL:'old-model'},readSecretFile:async()=>{throw Error('不应读取旧密钥');},readLocalSecret:async()=> 'test-secret-never-public',transport:async(url,options)=>{captured={url:String(url),...options};return {ok:true,json:async()=>({id:'mock-only',choices:[{message:{content:'候选建议'}}]})};}});
 assert.deepEqual(g.status,{ready:true,provider:'TokenHub',model:TOKENHUB_MODEL});assert.ok(!JSON.stringify(g.status).includes('test-secret'));
 const r=await g.complete([{role:'user',content:'测试'}]);assert.equal(r.answer,'候选建议');assert.equal(captured.url,TOKENHUB_BASE+'/chat/completions');assert.equal(captured.headers.Authorization,'Bearer test-secret-never-public');assert.equal(captured.redirect,'error');assert.ok(!captured.body.includes('test-secret'));assert.equal(JSON.parse(captured.body).thinking,undefined);
 await g.complete([{role:'user',content:'JSON'}],{json:true,maxTokens:14000});const b=JSON.parse(captured.body);assert.equal(b.model,TOKENHUB_MODEL);assert.equal(b.enable_thinking,true);assert.equal(b.reasoning_effort,'high');assert.deepEqual(b.response_format,{type:'json_object'});assert.equal(b.max_tokens,14000);
});
test('旧 Ark 凭证不自动转发，测试和禁用模式不读取钥匙串',async()=>{
 for(const env of [{ARK_API_KEY:'old',NODE_ENV:'test'},{ARK_API_KEY:'old',DECODING_DISABLE_LOCAL_KEY:'1'},{DECODING_API_BASE:'https://other.example/v1',TOKENHUB_API_KEY:'do-not-forward',ARK_API_KEY:'old'}]){
  const g=await createModelGateway({env,readLocalSecret:async()=>{throw Error('不应读取钥匙串');},readSecretFile:async()=>{throw Error('不应读取旧密钥');}});assert.equal(g.status.ready,false);await assert.rejects(()=>g.complete([]),/未配置/);
 }
});
test('普通聊天与拆解默认 high 思考；无效强度不发请求',async()=>{
 let sent,calls=0;
 const g=await createModelGateway({env:{TOKENHUB_API_KEY:'test-only'},transport:async(_url,options)=>{calls++;sent=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{}'},finish_reason:'stop'}]})};}});
 await g.complete([],{json:true,thinking:true,reasoningEffort:'max',maxTokens:65536});
 assert.equal(sent.enable_thinking,true);assert.equal(sent.reasoning_effort,'max');assert.equal(sent.max_tokens,65536);
 await g.complete([]);assert.equal(sent.enable_thinking,true);assert.equal(sent.reasoning_effort,'high');assert.equal(sent.max_tokens,65536);
 await assert.rejects(()=>g.complete([],{thinking:true,reasoningEffort:'ultra'}),/思考强度/);assert.equal(calls,2);
});
test('JSON 请求缺少格式指令时补齐，既有消息和普通聊天不变',async()=>{
 let sent;const g=await createModelGateway({env:{TOKENHUB_API_KEY:'test-only'},transport:async(_url,options)=>{sent=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{"ok":true}'}}]})};}});
 const messages=[{role:'system',content:'你是拆解器'},{role:'user',content:'返回候选'}],before=structuredClone(messages);
 await g.complete(messages,{json:true});assert.match(sent.messages[0].content,/JSON/);assert.deepEqual(sent.messages.slice(1),messages);assert.deepEqual(messages,before);
 await g.complete(messages);assert.deepEqual(sent.messages,messages);
 const explicit=[{role:'user',content:'返回 json 对象'}];await g.complete(explicit,{json:true});assert.deepEqual(sent.messages,explicit);
});
test('服务器环境变量和密钥文件可用于非 Mac 部署',async()=>{
 const g=await createModelGateway({env:{TOKENHUB_API_KEY:'env-only'},readLocalSecret:async()=>{throw Error('不应读取');}});assert.equal(g.status.ready,true);
 let path;const f=await createModelGateway({env:{DECODING_API_KEY_FILE:'/server/private/key'},readSecretFile:async p=>{path=p;return 'file-secret\n';}});assert.equal(f.status.ready,true);assert.equal(path,'/server/private/key');
});
test('仅文档指定地址允许 HTTP，拒绝任意 HTTP 和地址内凭证',async()=>{
 for(const base of ['http://other.example/v1','http://115.191.26.230:8001/api/openai/v1','http://115.191.26.230:8000/other/v1','https://name:secret@other.example/v1'])await assert.rejects(()=>createModelGateway({env:{DECODING_API_BASE:base}}),/HTTPS/);
});
test('模型失败或截断不假装成功',async()=>{
 const g=await createModelGateway({env:{DECODING_API_KEY:'test'},transport:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'不完整'}}]})})});await assert.rejects(()=>g.complete([]),/不完整/);
 const bad=await createModelGateway({env:{DECODING_API_KEY:'test'},transport:async()=>({ok:false,status:401})});await assert.rejects(()=>bad.complete([]),/401/);
});
test('Nexus 只得到当前领域公开消息，不得到私聊或其他群',()=>{const rows=[{channel:'private',author:'私人',text:'private-sentinel'},{channel:'group',scope:'eo',author:'其他群',text:'other-sentinel'},{channel:'group',scope:'bf01',author:'甲',text:'公开意见'}];assert.deepEqual(selectDiscussion(rows,{shared:true,scope:'bf01'}),[{author:'甲',text:'公开意见'}]);assert.deepEqual(selectDiscussion(rows,{shared:false}),[{author:'私人',text:'private-sentinel'}]);});
test('GPT（wangsu/gpt-6.1-sol）：不流式、用 max_completion_tokens、思考强度走 reasoning_effort，不发 DeepSeek 专用参数',async()=>{
 let body;const g=await createModelGateway({env:{DECODING_API_KEY:'test',DECODING_MODEL:'wangsu/gpt-6.1-sol'},transport:async(url,options)=>{body=JSON.parse(options.body);return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}]})};}});
 await g.complete([{role:'user',content:'JSON'}],{json:true,thinking:true,reasoningEffort:'high',maxTokens:65536});
 assert.equal(body.stream,undefined);assert.equal(body.max_completion_tokens,65536);assert.equal(body.max_tokens,undefined);
 assert.equal(body.reasoning_effort,'high');assert.equal(body.enable_thinking,undefined);assert.deepEqual(body.response_format,{type:'json_object'});
 const unknown=await createModelGateway({env:{DECODING_API_KEY:'test',DECODING_MODEL:'some/unverified-model'},transport:async()=>{throw Error('不应发出')}});
 await assert.rejects(()=>unknown.complete([{role:'user',content:'x'}],{thinking:true}),/未核实拆解思考参数/);
});
