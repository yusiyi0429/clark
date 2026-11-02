// Offline planning only. No gateway, job, store or runtime import is allowed here.
import {createHash} from 'node:crypto';
const clone=x=>structuredClone(x),bytes=x=>Buffer.byteLength(JSON.stringify(x));
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function packSourceText(sources){
 const rows=new Map();
 function visit(value,path=[]){
  if(!value||typeof value!=='object')return;
  for(const [key,part]of Object.entries(value)){
   const next=[...path,Array.isArray(value)?Number(key):key];
   if(key==='text'&&typeof part==='string'){
    const row=rows.get(part)||{text:part,paths:[]};row.paths.push(next);rows.set(part,row);
   }else visit(part,next);
  }
 }
 visit(sources);
 const packed=clone(sources),texts={},bindings=[];
 for(const {text,paths}of rows.values()){
  if(paths.length<2)continue;
  const id=digest(text),marker='@source-text:'+id,links=paths.map(path=>({path,textId:id}));
  if(bytes(marker)*paths.length+bytes({[id]:text})+bytes(links)>=bytes(text)*paths.length)continue;
  if(Object.hasOwn(texts,id)&&texts[id]!==text)throw Error('正文哈希冲突，不执行去重');
  texts[id]=text;
  for(const path of paths){let node=packed;for(const key of path.slice(0,-1))node=node[key];node[path.at(-1)]=marker;}
  bindings.push(...links);
 }
 return {sources:packed,texts,bindings,originalHash:digest(sources)};
}
export function restoreSourceText(packet){
 const sources=clone(packet.sources);
 for(const {path,textId}of packet.bindings){
  if(!Object.hasOwn(packet.texts,textId)||digest(packet.texts[textId])!==textId)throw Error('正文引用校验失败');
  let node=sources;for(const key of path.slice(0,-1)){if(!node||!Object.hasOwn(node,key))throw Error('来源路径不存在');node=node[key];}
  const key=path.at(-1);if(!Object.hasOwn(node,key)||node[key]!=='@source-text:'+textId)throw Error('来源引用位置已变化');node[key]=packet.texts[textId];
 }
 if(digest(sources)!==packet.originalHash)throw Error('来源完整性校验失败');return sources;
}

export function reviewModelRequestBody(system,payload,{model='wangsu/claude-sonnet-5-5',maxTokens=32000,thinking=true,reasoningEffort='high',json=true}={}){
 let messages=[{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}];
 if(json&&!messages.some(m=>/json/i.test(m.content)))messages=[{role:'system',content:'仅返回有效 JSON 对象，不加代码围栏。'},...messages];
 if(model==='wangsu/claude-sonnet-5-5')return {model,max_tokens:maxTokens,stream:true,system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n'),messages:messages.filter(m=>m.role!=='system'),...(thinking?{thinking:{type:'adaptive',display:'summarized'},output_config:{effort:reasoningEffort}}:{})};
 if(model==='aliyun/deepseek-v4.1-flash')return {model,stream:true,stream_options:{include_usage:true},enable_thinking:thinking,...(thinking?{reasoning_effort:reasoningEffort}:{}),max_tokens:maxTokens,...(json?{response_format:{type:'json_object'}}:{}),messages};
 throw Error('未定义该测试模型的实际请求适配器，不能套用其他模型预算');
}
export const anthropicReviewBody=(system,payload,options={})=>{if(options.model&&options.model!=='wangsu/claude-sonnet-5-5')throw Error('不能把非Messages模型套用Anthropic请求体');return reviewModelRequestBody(system,payload,options);};


const scopeRules='本包检查 scope.targetRefs 及 scope.edges，问题只能归属 scope.allowedIssueRefs。sources 为 scope.sourceRefs 的完整原始来源。每个对象保持自己的E编号/旧E命名空间，不得跨对象把同编号当同证据。sourceTexts 和 sourceBindings 是完全相同正文的无损引用：按 binding.path 把来源字段中的 @source-text 标记替换为对应完整正文；不同出处、日期、版本和负责人记录仍分别保留，不得合并证据强度。reviews 中非目标项仅为父子上下文，不把候选结论当原始事实，不以本包没有其他对象来源断言其没发生。关系包检查 scope.edges，覆盖其两端完整来源。kind=requested-context只是程序排序后的补查关联，不是本体父子关系；必须按sourceRequestContext逐条核对具体relation/reason，并返回sourceRequestAnswers:[{requestId,conclusion}]给出每条补查的具体结论（仍缺材料则明确说缺什么并返回sourceRequests），不能只列checkedRefs冒充答复。所有28份当前候选和全局测量均保留作一致性上下文。若检查需要本包未提供的其他对象原文，必须返回 sourceRequests:[{refs:[本包目标ref,需要核查的冻结对象ref],relation:需要核对的具体关系,reason:原因}]，不得猜关系、把未提供当没发生或强置fixable:false；有补源请求不能算检查完成。输出保留 issues 原有 ref/type/problem/impact/mustFix/fixable，另须 checkedRefs、checkedEdges 和 sourceRequests 数组；无问题/无补源也显式给空数组。';
export function buildReviewCheckPlan({input,sources,reviews,programFacts,tasks,system,maxBodyBytes=512*1024,maxTargetRefs=3,wireOptions={},extraRelations=[],fixedLayout=null}){
 if(tasks?.length!==3||tasks.some(t=>typeof t!=='string'||!t)||!Number.isInteger(maxTargetRefs)||maxTargetRefs<1||!Number.isInteger(maxBodyBytes)||maxBodyBytes<1)throw Error('必须保留三组检查任务及有效预算');
 const items=input.stages.flat(),byId=new Map(items.map(c=>[c.id,c])),current=Array.isArray(reviews)?Object.fromEntries(reviews.map(r=>[r.ref,r])):reviews;
 for(const id of Object.keys(sources))if(!byId.has(id))throw Error('来源没有对应冻结对象：'+id);
 for(const c of items)if(!Object.hasOwn(sources,c.id)||!Object.hasOwn(current,c.id))throw Error('对象缺少完整来源或候选：'+c.id);
 const parent=new Map(),edges=[];
 for(const c of items)for(const child of c.children||[]){if(!byId.has(child))throw Error('父子引用不完整');parent.set(child,c.id);edges.push({parentRef:c.id,childRef:child});}
 const make=(kind,units)=>{
  const own=kind==='object'?units:units.flatMap(e=>[e.parentRef,e.childRef]),targets=[...new Set(own)];
  const context=new Set(targets);for(const id of targets){if(parent.has(id))context.add(parent.get(id));for(const child of byId.get(id).children||[])context.add(child);}
  const sourceRefs=[...new Set([...targets,...targets.map(id=>parent.get(id)).filter(Boolean)])];
  const original=Object.fromEntries(sourceRefs.map(id=>[id,sources[id]])),packed=packSourceText(original);
  const related=kind==='relation'?units:edges.filter(e=>targets.includes(e.childRef)&&sourceRefs.includes(e.parentRef));
  const scope={kind,targetRefs:targets,sourceRefs,allowedIssueRefs:[...new Set([...targets,...related.flatMap(e=>[e.parentRef,e.childRef])])],reviewRefs:Object.keys(current),edges:related};
  const perReview=programFacts?.perReview||{},facts={...programFacts,perReview:Object.fromEntries([...context].filter(id=>Object.hasOwn(perReview,id)).map(id=>[id,perReview[id]]))};
  const payloads=tasks.map(task=>({task:task+'\n'+scopeRules,reviews:Object.values(current),programFacts:facts,sources:packed.sources,sourceTexts:packed.texts,sourceBindings:packed.bindings,scope,sourceHash:digest(original),candidateHash:digest(current)}));
  const bodies=payloads.map(payload=>bytes(reviewModelRequestBody(system,payload,wireOptions)));
  return {kind,scope,originalHash:packed.originalHash,payloads,maxBodyBytes:Math.max(...bodies),sourceBytes:bytes(original),packedSourceBytes:bytes(packed),sourceEvidenceCount:sourceRefs.reduce((n,id)=>n+(sources[id].evidence?.length||0),0)};
 };
 const packets=[];
 const append=(kind,units)=>{
  let pending=[];
  for(const unit of units){
   const next=[...pending,unit],built=make(kind,next);
   if(built.scope.targetRefs.length<=maxTargetRefs&&built.maxBodyBytes<=maxBodyBytes){pending=next;continue;}
   if(pending.length)packets.push(make(kind,pending));
   const single=make(kind,[unit]);if(single.scope.targetRefs.length>maxTargetRefs)throw Object.assign(Error('完整关联超过对象上限，禁止丢弃关联'),{code:'REVIEW_PACKET_REF_LIMIT'});if(single.maxBodyBytes>maxBodyBytes)throw Object.assign(Error('单对象或完整关系来源超过离线预算，禁止截断'),{code:'REVIEW_PACKET_OVERSIZE',scope:single.scope,actual:single.maxBodyBytes,budget:maxBodyBytes});
   pending=[unit];
  }
  if(pending.length)packets.push(make(kind,pending));
 };
 if(fixedLayout){for(const item of fixedLayout){if(!['object','relation'].includes(item.kind)||!item.units?.length)throw Error('分组布局无效');const packet=make(item.kind,item.units);if(packet.maxBodyBytes>maxBodyBytes)throw Object.assign(Error('固定分组在新候选下超过预算，禁止自动增加付费包'),{code:'REVIEW_PACKET_OVERSIZE'});packets.push(packet);}}else{
 append('object',[...items].sort((a,b)=>String(a.unit).localeCompare(String(b.unit))||({company:0,ru:1,mission:2}[a.level]??3)-({company:0,ru:1,mission:2}[b.level]??3)).map(c=>c.id));
 const covered=new Set(packets.flatMap(p=>p.scope.edges.map(e=>e.parentRef+'>'+e.childRef)));
 const missing=edges.filter(e=>!covered.has(e.parentRef+'>'+e.childRef));if(missing.length)append('relation',missing);
 for(const relation of extraRelations){if(relation.length!==2||relation.some(ref=>!byId.has(ref)))throw Error('跨单元关联必须明确两个冻结对象');append('relation',[{parentRef:relation[0],childRef:relation[1]}]);}
 }
 const layout=packets.map(p=>({kind:p.kind,units:p.kind==='object'?p.scope.targetRefs:p.scope.edges}));
 const plan={schemaVersion:1,offlineOnly:true,inputHash:digest(input),sourceHash:digest(sources),candidateHash:digest(current),systemHash:digest(system),tasksHash:digest(tasks),factsHash:digest(programFacts),maxBodyBytes,maxTargetRefs,maxConcurrency:3,wireOptions,layout,sourceRefs:items.map(c=>c.id),edges,packets,requestCount:packets.length*tasks.length};
 plan.stamp=digest(plan);return plan;
}

export function refreshReviewCheckPlan(plan,args){
 if(digest(args.wireOptions||{})!==digest(plan.wireOptions))throw Error('测试模型或调用参数已变化，不能复用分组缓存');
 if(plan.inputHash!==digest(args.input)||plan.sourceHash!==digest(args.sources)||plan.systemHash!==digest(args.system)||plan.tasksHash!==digest(args.tasks))throw Error('冻结来源、技能或检查任务已变化，不能复用分组');
 return buildReviewCheckPlan({...args,maxBodyBytes:plan.maxBodyBytes,maxTargetRefs:plan.maxTargetRefs,wireOptions:plan.wireOptions,fixedLayout:plan.layout});
}
export function verifyReviewCheckPlan(plan,args){
 const rebuilt=refreshReviewCheckPlan(plan,args);
 if(rebuilt.stamp!==plan.stamp||digest(rebuilt)!==digest(plan))throw Error('分组缓存与当前候选或保存内容不一致');return true;
}
export function validateScopedCheckResult(value,packet,allSourceRefs,sourceRequestContext=null){
 if(!value||!Array.isArray(value.issues)||!Array.isArray(value.checkedRefs)||!Array.isArray(value.checkedEdges)||!Array.isArray(value.sourceRequests))throw Error('分组检查缺少覆盖或补源合同，不能当无问题');
 const scope=packet.scope,edgeId=e=>e.parentRef+'>'+e.childRef;
 const checkedEdges=value.checkedEdges.map(edge=>{
  if(typeof edge!=='string')return edge;
  const matches=scope.edges.filter(expected=>edge===expected.parentRef+'->'+expected.childRef);
  if(matches.length!==1)throw Error('检查边字符串没有唯一对应的已声明关系');
  return {...matches[0]};
 });
 const subset=(given,expected)=>new Set(given).size===given.length&&given.every(x=>expected.includes(x));
 const checkableRefs=scope.sourceRefs.filter(ref=>scope.allowedIssueRefs.includes(ref));
 if(!subset(value.checkedRefs,checkableRefs)||!subset(checkedEdges.map(edgeId),scope.edges.map(edgeId)))throw Error('分组检查覆盖对象不正确');
 for(const issue of value.issues)if(!scope.allowedIssueRefs.includes(issue.ref)||typeof issue.mustFix!=='boolean'||typeof issue.fixable!=='boolean'||!issue.type||!issue.problem||!issue.impact)throw Error('分组检查问题缺少来源范围或原有合同字段');
 for(const need of value.sourceRequests)if(!Array.isArray(need.refs)||need.refs.length<2||new Set(need.refs).size!==need.refs.length||!need.refs.every(ref=>allSourceRefs.includes(ref))||!need.refs.some(ref=>scope.targetRefs.includes(ref))||need.refs.every(ref=>scope.sourceRefs.includes(ref))||typeof need.relation!=='string'||!need.relation.trim()||typeof need.reason!=='string'||!need.reason.trim())throw Object.assign(Error('补源必须指向本包相关的具体冻结对象集合/关系/理由，不能重复索要已提供原文'),{code:'REVIEW_SOURCE_REQUEST_CONTRACT'});
 if(!value.sourceRequests.length&&(scope.targetRefs.some(ref=>!value.checkedRefs.includes(ref))||value.checkedEdges.length!==scope.edges.length))throw Error('覆盖未完成，不能以空问题当通过');
 if(sourceRequestContext){const expected=sourceRequestContext.requests.map(r=>r.requestId),answers=value.sourceRequestAnswers;if(!Array.isArray(answers)||answers.length!==expected.length||new Set(answers.map(a=>a.requestId)).size!==expected.length||answers.some(a=>!expected.includes(a.requestId)||typeof a.conclusion!=='string'||!a.conclusion.trim()))throw Object.assign(Error('补查未逐项回答原具体关系问题，不能通过'),{code:'REVIEW_SOURCE_REQUEST_UNANSWERED'});}
 return {...value,checkedEdges,status:value.sourceRequests.length?'needs-source-context':'checked'};
}
export function planSourceFollowups({plan,args,responses,providedKeys=[],maxAdditionalRequests}){
 verifyReviewCheckPlan(plan,args);
 if(!Number.isInteger(maxAdditionalRequests)||maxAdditionalRequests<0)throw Error('补查预算必须事先明确');
 const pending=new Map();
 for(const {packetIndex,group,value}of responses){
  if(!Number.isInteger(group)||group<0||group>=3||!plan.packets[packetIndex])throw Error('补查分组或作用域无效');
  const result=validateScopedCheckResult(value,plan.packets[packetIndex],plan.sourceRefs);
  for(const request of result.sourceRequests){
   const refs=[...request.refs].sort(),key=digest({candidateHash:plan.candidateHash,group,refs,model:plan.wireOptions});
   if(providedKeys.includes(key))throw Object.assign(Error('同一候选和检查组已提供这些原文，不得重复索取'),{code:'REVIEW_SOURCE_REQUEST_REPEAT'});
   if(!pending.has(key))pending.set(key,{key,group,refs,reasons:[]});pending.get(key).reasons.push({packetIndex,relation:request.relation,reason:request.reason});
  }
 }
 if(pending.size>maxAdditionalRequests)throw Object.assign(Error('相关来源补查超过已声明调用预算，未发请求'),{code:'REVIEW_SOURCE_REQUEST_BUDGET',required:pending.size,budget:maxAdditionalRequests});
 return [...pending.values()].map(request=>{
  const edges=request.refs.slice(1).map(ref=>({parentRef:request.refs[0],childRef:ref,kind:'requested-context'}));
  // Recheck the original parent/child edges involving the requested local object,
  // so a deferred edge can be completed with its full original sources.
  for(const reason of request.reasons)for(const edge of plan.packets[reason.packetIndex].scope.edges)if(request.refs.includes(edge.childRef)||request.refs.includes(edge.parentRef))if(!edges.some(e=>e.parentRef===edge.parentRef&&e.childRef===edge.childRef))edges.push(edge);
  const related=buildReviewCheckPlan({...args,maxBodyBytes:plan.maxBodyBytes,maxTargetRefs:Math.max(plan.maxTargetRefs,new Set(edges.flatMap(e=>[e.parentRef,e.childRef])).size),wireOptions:plan.wireOptions,fixedLayout:[{kind:'relation',units:edges}]}),packet=related.packets[0];
  const payload=packet.payloads[request.group];
  payload.sourceRequestContext={group:request.group,requests:request.reasons.map((reason,index)=>({requestId:request.key+':'+index,refs:request.refs,relation:reason.relation,reason:reason.reason,originalScope:plan.packets[reason.packetIndex].scope}))};
  const bodyBytes=bytes(reviewModelRequestBody(args.system,payload,plan.wireOptions));
  if(bodyBytes>plan.maxBodyBytes)throw Object.assign(Error('完整补查问题及来源超过预算，未发请求'),{code:'REVIEW_PACKET_OVERSIZE',actual:bodyBytes,budget:plan.maxBodyBytes});
  return {...request,packet,payload,cacheStamp:digest({base:plan.stamp,key:request.key,payload}),bodyBytes};
 });
}
export async function executeReviewCheckPlan({plan,args,runPacket,maxAdditionalRequests=0,providedKeys=[]}){
 verifyReviewCheckPlan(plan,args);
 const pool=async(calls)=>{let cursor=0,stopped=false;const results=[];const workers=await Promise.allSettled(Array.from({length:Math.min(plan.maxConcurrency,calls.length)},async()=>{while(!stopped&&cursor<calls.length){const index=cursor++,call=calls[index];try{const value=await runPacket(call);results[index]=validateScopedCheckResult(value,call.packet,plan.sourceRefs,call.payload.sourceRequestContext);}catch(error){stopped=true;throw error;}}}));const failed=workers.find(x=>x.status==='rejected');if(failed)throw failed.reason;return results;};
 const calls=plan.packets.flatMap((packet,index)=>packet.payloads.map((payload,group)=>({packet,index,group,payload,cacheStamp:plan.stamp}))),results=await pool(calls);
 const requests=results.flatMap((value,index)=>value.sourceRequests.length?[{packetIndex:calls[index].index,group:calls[index].group,value}]:[]);
 let followups=[],extra=[];
 if(requests.length&&maxAdditionalRequests>0){followups=planSourceFollowups({plan,args,responses:requests,providedKeys,maxAdditionalRequests});extra=await pool(followups.map(request=>({...request,index:null})));}
 for(let index=0;index<results.length;index++){const base=calls[index],related=extra.filter((_value,n)=>followups[n].group===base.group&&followups[n].reasons.some(r=>r.packetIndex===base.index)),checkedRefs=new Set([...(results[index].checkedRefs||[]),...related.flatMap(r=>r.checkedRefs)]),edgeId=e=>e.parentRef+'>'+e.childRef,checkedEdges=new Set([...(results[index].checkedEdges||[]),...related.flatMap(r=>r.checkedEdges)].map(edgeId));if(!results[index].sourceRequests.length||extra.length){if(base.packet.scope.targetRefs.some(ref=>!checkedRefs.has(ref))||base.packet.scope.edges.some(edge=>!checkedEdges.has(edgeId(edge))))throw Error('补查后仍有未覆盖对象或关系，不能当检查完成');}}
 const pending=extra.length?extra.flatMap(x=>x.sourceRequests):results.flatMap(x=>x.sourceRequests);
 const all=[...results,...extra];
 return {status:pending.length?'needs-source-context':'checked',results,followupResults:extra,issues:all.flatMap(x=>x.issues),sourceRequests:pending,providedKeys:[...providedKeys,...followups.map(x=>x.key)],requestCount:calls.length+followups.length};
}
