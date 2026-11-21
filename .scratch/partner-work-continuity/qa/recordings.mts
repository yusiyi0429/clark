import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createAcceptanceApp, actors } from './fixture.mts';
import { mapResult } from '../../../apps/api/src/volcAsr.js';
import { recordingOutcome } from '../../../apps/api/test/feishuMinutesFixtures.js';

const clock=new Date(); const joined:Buffer[]=[];
const vendor={audio_info:{duration:12000},result:{utterances:[{text:'录音确认甲负责核对。',start_time:1000,end_time:3000,additions:{speaker:'0'}},
  {text:'乙同意照此办理。',start_time:5000,end_time:7000,additions:{speaker:'1'}}]}};
const f=await createAcceptanceApp({runtime:{now:()=>clock,outcomeAgent:recordingOutcome()},recordingDeps:{
  configured:()=>({tos:true,asr:true}),assertConfigured(){},async transcode(input,output){joined.push(await readFile(input));await writeFile(output,Buffer.from([7,8,9]));return output;},
  async upload(){},presign:()=> 'https://recordings.example.invalid/fixture.mp3',async submit(){return 'qa-asr-1';},
  async query(){return {state:'done',...mapResult(vendor),raw:vendor};},pollIntervalMs:1,maxWaitMs:1000}});
const ok=(r:any,status=200)=>{assert.equal(r.statusCode,status,r.body);return r.json();};
try {
  const a=await f.login(0),b=await f.login(1),c=await f.login(2);
  await f.pool.query('INSERT INTO capability_config(id,version,name,"group",six_month_outcome,code,owner_id) VALUES ($1,1,$2,$3,$4,$5,$6)',
    ['qa-recording','会场验收','test','','99',actors[0].personId]);
  const start=new Date(+clock+60_000),end=new Date(+start+10*60_000);
  const card=ok(await f.call(a,'POST','/api/meetings',{title:'现场录音验收',scheduledAt:start.toISOString(),endsAt:end.toISOString(),participants:[actors[1].personId],anchors:[{kind:'unit',id:'qa-recording'}]})).card;
  const id=card.objectRef.id,base=`/api/meetings/${id}/recordings`;
  const receipt=async(who:string)=>ok(await f.call(who,'GET','/api/me/partner-meetings')).items.find((r:any)=>r.meetingId===id);
  const pending=await receipt(a);assert.equal(pending.canStartRecording,true);assert.equal(pending.recordHref,null);
  assert.equal((await receipt(b)).canStartRecording,false);assert.equal(await receipt(c),undefined);
  const source=ok(await f.call(a,'POST',base),201).recordingId;
  assert.equal(ok(await f.call(a,'POST',base)).recordingId,source);assert.equal((await receipt(a)).stage,'live');
  for (const [sequence,buffer] of [[1,Buffer.from([3,4])],[0,Buffer.from([1,2])]] as const) ok(await f.call(a,'PUT',`${base}/${source}/chunks/${sequence}`,buffer,{'content-type':'audio/webm'}));
  ok(await f.call(a,'POST',`${base}/${source}/finish`),202);
  await f.recordingService!.idle();assert.deepEqual(joined,[Buffer.from([1,2,3,4])]);
  assert.equal(ok(await f.call(a,'GET',`${base}/${source}`)).status,'done');
  assert.equal((await receipt(b)).recordHref,null);
  const fresh=ok(await f.call(a,'GET',`/api/me/cards/meetings/${id}`));
  const action=fresh.actions.find((x:any)=>x.actionType==='meeting.confirm_transcript_candidate');assert.ok(action,JSON.stringify(fresh.actions));
  ok(await f.call(a,'POST','/api/actions/execute',{actionId:action.actionId,input:{speakerMappings:[{speakerName:'说话人 1',personId:actors[0].personId},
    {speakerName:'说话人 2',personId:actors[1].personId}],confirmAddParticipants:true}}));
  const recipient=await receipt(await f.login(1));assert.equal(recipient.id,pending.id);assert.equal(recipient.stage,'ready');
  assert.match(ok(await f.call(b,'GET',recipient.recordHref)).text,/甲负责核对/);assert.equal((await f.call(c,'GET',recipient.recordHref)).statusCode,404);
  console.log(JSON.stringify({localRecordedChunksReassembledInOrder:true,syntheticTranscription:true,openedByHostAndAttendeeAfterConfirm:true,
    pendingCandidateNotDelivered:true,originalReceiptId:true,outsiderDenied:true,microphone:'not exercised'}));
}finally{await f.close();}
