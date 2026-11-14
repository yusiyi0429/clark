import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceApp, actors } from './fixture.mts';
import { storeSessionAttachments } from '../../../apps/api/src/sessionAttachments.js';
import { setMemberAccess } from '../../../apps/api/src/memberAccess.js';

const base='/api/me/team-deliveries';
const f=await createAcceptanceApp();
const bytes=Buffer.from([0,1,2,64,128,255,13,10]);
const answer=Buffer.from('答复附件：已核实两条反馈\n','utf8');
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const ok=(response:any, allowed=[200,201])=>{assert.ok(allowed.includes(response.statusCode),`${response.statusCode}: ${response.body}`);return response.json();};
const upload=async(cookie:string,url:string,body:Record<string,unknown>,name:string,data:Buffer)=>{
  const boundary='qa-'+randomUUID();
  const encoded=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(body)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),data,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return f.call(cookie,'POST',url,encoded,{'content-type':'multipart/form-data; boundary='+boundary});
};
try {
  const a=await f.login(0),b=await f.login(1),c=await f.login(2);
  const project=ok(await f.call(a,'POST','/api/me/projects',{name:'文件源归属项目'}));
  const form={clientId:randomUUID(),kind:'share',recipientIds:[actors[1].personId],text:'发给乙核对这份指定版本',sourceUrl:'https://example.invalid/qa/source'};
  const shared=ok(await upload(a,base,form,'source.pdf',bytes)).delivery;
  const replay=ok(await upload(a,base,form,'source.pdf',bytes)).delivery;
  assert.equal(replay.id,shared.id);
  const inbox=async(cookie:string)=>ok(await f.call(cookie,'GET',base+'?box=received')).items;
  const signInAgain=await f.login(1);
  const got=(await inbox(signInAgain)).filter((d:any)=>d.id===shared.id);
  assert.equal(got.length,1);assert.equal(got[0].text,form.text);assert.equal(got[0].sourceUrl,form.sourceUrl);
  const file=got[0].attachments[0];assert.equal(file.sha256,digest(bytes));
  const download=await f.call(signInAgain,'GET',file.href);assert.equal(download.statusCode,200,download.body);assert.deepEqual(download.rawPayload,bytes);
  assert.equal((await inbox(c)).some((d:any)=>d.id===shared.id),false);
  for(const path of [`${base}/${shared.id}`,file.href,`/api/me/projects/${project.projectId}`]) assert.equal((await f.call(c,'GET',path)).statusCode,404);
  assert.equal((await f.call(b,'GET',`/api/me/projects/${project.projectId}`)).statusCode,404);
  console.log(JSON.stringify({fileDelivery:true,offlineLoginAgain:true,exactSha256AndBytes:true,unrelatedDenied:true,replayOne:true}));

  const topic=randomUUID();await f.pool.query('INSERT INTO research_topics(id,owner_id,title,project_id) VALUES($1,$2,$3,$4)',
    [topic,actors[0].personId,'原始附件专题',project.projectId]);
  const [selected,sibling]=await storeSessionAttachments(f.pool.query.bind(f.pool),f.storage,actors[0].personId,{kind:'topic',id:topic},
    [{filename:'selected.pdf',buffer:bytes},{filename:'adjacent.txt',buffer:answer}],new Date());
  const linked=ok(await f.call(a,'POST',base,{clientId:randomUUID(),kind:'share',recipientIds:[actors[1].personId],text:'指定原件的版本',
    sourceAttachments:[{id:selected.id,sha256:selected.sha256}]})).delivery;
  const downloadRef=linked.attachments[0].href;
  assert.deepEqual((await f.call(b,'GET',downloadRef)).rawPayload,bytes);
  for(const original of [selected,sibling]) assert.equal((await f.call(b,'GET','/api/me/session-attachments/'+original.id)).statusCode,404);
  await f.pool.query('UPDATE session_attachments SET sha256=$1 WHERE id=$2',['f'.repeat(64),selected.id]);
  assert.ok([403,404,409,410].includes((await f.call(b,'GET',downloadRef)).statusCode));
  assert.equal((await f.call(c,'GET',downloadRef)).statusCode,404);
  const delegatedTopic=randomUUID();await f.pool.query('INSERT INTO research_topics(id,owner_id,title,project_id) VALUES($1,$2,$3,$4)',
    [delegatedTopic,actors[2].personId,'他人上传的项目原件',project.projectId]);
  const [delegatedFile]=await storeSessionAttachments(f.pool.query.bind(f.pool),f.storage,actors[2].personId,{kind:'topic',id:delegatedTopic},
    [{filename:'delegated.txt',buffer:answer}],new Date());
  const authorized=ok(await f.call(a,'POST',base,{clientId:randomUUID(),kind:'share',recipientIds:[actors[1].personId],
    sourceAttachments:[{id:delegatedFile.id,sha256:delegatedFile.sha256}]})).delivery;
  const delegatedHref=authorized.attachments[0].href;
  assert.deepEqual((await f.call(b,'GET',delegatedHref)).rawPayload,answer);
  await f.pool.query('UPDATE projects SET owner_id=$1 WHERE id=$2',[actors[3].personId,project.projectId]);
  assert.equal((await f.call(a,'GET','/api/me/session-attachments/'+delegatedFile.id)).statusCode,404);
  assert.equal((await f.call(b,'GET',delegatedHref)).statusCode,404);
  assert.equal((await f.call(b,'GET',delegatedHref+'/text')).statusCode,404);
  assert.equal((await f.call(b,'GET',base+'/'+authorized.id)).statusCode,200);
  await f.pool.query('UPDATE projects SET owner_id=$1 WHERE id=$2',[actors[0].personId,project.projectId]);
  console.log(JSON.stringify({sourceVersionRechecked:true,originalAccessRevokedAndRecheckedForBytesAndText:true,onlySelectedFileShared:true,siblingAndOriginalTopicRemainPrivate:true}));

  const q=ok(await f.call(a,'POST',base,{clientId:randomUUID(),kind:'question',recipientIds:[actors[1].personId,actors[2].personId],text:'请各给两条反馈。',dueAt:new Date(Date.now()+600000).toISOString()})).delivery;
  const replyPath=`${base}/${q.id}/replies`;
  const waiting=async(who:string)=>ok(await f.call(who,'GET','/api/me/work-home')).waiting.find((x:any)=>x.kind==='team_request' && x.id==='team-request:'+q.id);
  assert.deepEqual((await waiting(b)).open,{kind:'team_request',id:q.id});
  const response={clientId:randomUUID(),status:'answered',text:'验收乙的两条反馈'};
  ok(await upload(b,replyPath,response,'reply.txt',answer));
  ok(await upload(b,replyPath,response,'reply.txt',answer));
  const original=async(cookie:string)=>ok(await f.call(cookie,'GET',`${base}/${q.id}`)).delivery;
  let progress=await original(a);
  const per=(d:any,actor:number)=>d.recipients.find((row:any)=>row.personId===actors[actor].personId);
  assert.equal(per(progress,1).status,'answered');assert.equal(per(progress,2).status,'pending');
  assert.equal(await waiting(b),undefined);assert.deepEqual((await waiting(c)).open,{kind:'team_request',id:q.id});
  assert.equal(per(progress,1).replies.length,1);const att=per(progress,1).replies[0].attachments[0];
  assert.equal(att.sha256,digest(answer));assert.deepEqual((await f.call(a,'GET',att.href)).rawPayload,answer);
  assert.equal((await f.call(c,'GET',att.href)).statusCode,404);
  assert.equal(ok(await f.call(a,'GET',att.href+'/text')).text,answer.toString('utf8').trim());assert.equal((await f.call(c,'GET',att.href+'/text')).statusCode,404);
  ok(await f.call(c,'POST',replyPath,{clientId:randomUUID(),status:'needs_info',text:'请先说明反馈周次'}));
  assert.equal(per(await original(a),2).status,'needs_info');assert.ok(await waiting(a));assert.equal(await waiting(c),undefined);
  ok(await f.call(a,'POST',replyPath,{clientId:randomUUID(),status:'clarification',recipientId:actors[2].personId,text:'请填本周'}));
  assert.equal(await waiting(a),undefined);assert.ok(await waiting(c));
  ok(await f.call(c,'POST',replyPath,{clientId:randomUUID(),status:'answered',text:'验收丙的独立回复'}));
  progress=await original(a);assert.equal(per(progress,1).replies[0].text,response.text);
  assert.equal(per(progress,2).replies.at(-1).text,'验收丙的独立回复');assert.equal(per(progress,2).status,'answered');
  assert.equal(await waiting(c),undefined);
  console.log(JSON.stringify({twoRecipientQuestion:true,originalReceivedReplies:true,secondStayedPendingUntilSubmission:true,
    sourceRepliesIndependent:true,replyAttachmentBytes:true,cannotReadPeerReplyAttachment:true,retryNoDuplicateAnswer:true,clarificationMovedWaitingBetweenOriginalActors:true}));
  await f.pool.query('DELETE FROM member_access WHERE person_id=$1',[actors[3].personId]);
  const mixed=ok(await f.call(a,'POST',base,{clientId:randomUUID(),kind:'share',recipientIds:[actors[1].personId,actors[3].personId],text:'逐人恢复来件'})).delivery;
  assert.equal(per(mixed,1).status,'delivered');assert.equal(per(mixed,3).status,'failed');
  await setMemberAccess(f.pool.query.bind(f.pool),{...actors[3],mustChange:false});const restored=await f.login(3);
  assert.equal((await f.call(restored,'GET',`${base}/${mixed.id}`)).statusCode,404);
  const target=`${base}/${mixed.id}/recipients/${actors[3].personId}/retry`;
  assert.equal((await f.call(b,'POST',target)).statusCode,404);
  const result=ok(await f.call(a,'POST',target)).delivery;assert.equal(per(result,3).status,'delivered');
  ok(await f.call(a,'POST',target));assert.equal((await inbox(b)).filter((d:any)=>d.id===mixed.id).length,1);assert.equal((await inbox(restored)).filter((d:any)=>d.id===mixed.id).length,1);
  console.log(JSON.stringify({unprovisionedRecipientPersistedAsFailed:true,onlyFailedRecipientRetried:true,originalReceiverStayedSingle:true}));
}finally{await f.close();}
