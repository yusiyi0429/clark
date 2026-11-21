import assert from 'node:assert/strict';
import { createAcceptanceApp, actors } from './fixture.mts';
import { authorize, feishuEnv, recordingOutcome } from '../../../apps/api/test/feishuMinutesFixtures.js';
import { FEISHU_CALENDAR_SCOPES, FEISHU_MINUTES_READ_SCOPES } from '../../../apps/api/src/feishu/oauth.js';
import { preflightCandidate } from '../../../apps/api/test/helpers.js';

const clock = new Date();
const start = new Date(clock.getTime() + 12 * 60_000);
const end = new Date(start.getTime() + 18 * 60_000);
const stamp = (date: Date) => new Date(+date + 8 * 60 * 60_000).toISOString().slice(0,19).replace('T',' ');
const token = 'obcn_partner_test_001';
const minute = { token, title: '预约纪要验收', ownerOpenId:'ou_0', createdAt: start,
  durationSeconds:1080, url:'https://source.example.invalid/minutes/' + token, meetingId:'vc_qa_001', sourceType:'meeting' as const };
const text = [stamp(start)+' CST|18min 0s','','关键词:','伙伴验收','','验收成员甲 00:00:05.120 ','约定由业务负责人先核对示例。','','验收成员乙 00:00:15.002 ','同意先核对示例。',''].join('\n');
let released = false;
const laterStart = new Date(+end + 12 * 60_000);
const ambiguous = { ...minute, token:'obcn_partner_test_ambiguous', title:'相邻的两场验收', createdAt:laterStart,
  durationSeconds:480, url:'https://source.example.invalid/minutes/obcn_partner_test_ambiguous', meetingId:'vc_qa_ambiguous' };
let otherReleased = false;
const reads: string[] = [], invitees: string[] = [];
const join='https://meetings.example.invalid/j/736000001';
const f = await createAcceptanceApp({env:{feishu:{ ...feishuEnv,appId:'qa_client',appSecret:'fixture-only' }, feishuWebOrigin:'https://source.example.invalid'},
  runtime:{now:()=>clock, preflightAgent:{ async generate(input){return {candidate:preflightCandidate(input.issues.map((item:any)=>'issue:'+item.id))};}},
    outcomeAgent:recordingOutcome(), meetingFollowThroughAgents:{
      calendarApi:{async primaryCalendarId(){return 'qa_calendar';},async createEvent(){return { eventId:'calendar_qa_001',joinUrl:join};},
        async addAttendees(_token,_calendar,_event,ids){invitees.push(...ids);},async updateEvent(){},async deleteEvent(){},async listInstances(){return [];}},
      minutesApi:{async getMinute(_reader,key){return key===ambiguous.token?ambiguous:minute;},
        async listMinutes(_reader,owner,_range,skip){return owner.openId==='ou_0'?[...(released?[minute]:[]),...(otherReleased?[ambiguous]:[])].filter(m=>!skip?.has(m.token)):[];},
        async artifactTranscript(reader,key){reads.push(reader);return key===ambiguous.token?text.replace(stamp(start),stamp(laterStart)).replace('先核对示例','只复核第二场附件'):text;},
        async exportTranscript(reader,key){reads.push(reader);return key===ambiguous.token?text.replace(stamp(start),stamp(laterStart)).replace('先核对示例','只复核第二场附件'):text;},
        async meetingParticipants(){return ['ou_0','ou_1'];} } } }});

const ok = (response:any,status=200) => {assert.equal(response.statusCode,status,response.body);return response.json();};
try {
  await f.pool.query('INSERT INTO capability_config(id,version,name,"group",six_month_outcome,code,owner_id) VALUES ($1,1,$2,$3,$4,$5,$6)',
    ['qa-capability','伙伴验收单元','test','','99',actors[0].personId]);
  const people = [await f.login(0),await f.login(1),await f.login(2),await f.login(3)];
  const scope = [...FEISHU_MINUTES_READ_SCOPES,...FEISHU_CALENDAR_SCOPES].join(' ');
  for(let i=0;i<actors.length;i++) await authorize(f as any,actors[i].personId,'ou_'+i,actors[i].displayName,clock,scope);
  const booked = ok(await f.call(people[0], 'POST','/api/meetings',{title:'预约纪要验收',scheduledAt:start.toISOString(),endsAt:end.toISOString(),
    participants:[actors[1].personId],anchors:[{kind:'unit',id:'qa-capability'}]}));
  const id = booked.card.objectRef.id;
  await f.app.meetingFollowThrough.feishuEvents.sync({meetingId:id});
  const base = '/api/me/partner-meetings';
  const visible = async (cookie:string) => ok(await f.call(cookie,'GET',base)).items.filter((item:any)=>item.meetingId===id);
  const scheduled = await visible(people[1]);
  assert.equal(scheduled.length,1,JSON.stringify(scheduled));
  assert.equal(scheduled[0].joinUrl,join);
  assert.deepEqual(await visible(people[2]),[]);
  assert.deepEqual(await visible(people[3]),[]);
  assert.ok(scheduled[0].preflightText);
  console.log(JSON.stringify({scheduled:true,invitees,joinSourceReturned:true,outsiderAndNonattendingCeoExcluded:true}));
  assert.deepEqual(invitees,['ou_1']);

  clock.setTime(+start + 1000);
  await f.app.meetingFollowThrough.minutes.onMeetingStarted({meeting:{ id:minute.meetingId,calendar_event_id:'calendar_qa_001', start_time:start.toISOString() }});
  assert.equal((await visible(people[1]))[0].stage,'live');
  clock.setTime(+end + 5 * 60_000);
  await f.app.meetingFollowThrough.minutes.onMeetingEnded({meeting:{ id:minute.meetingId,calendar_event_id:'calendar_qa_001',end_time:end.toISOString() }});
  await f.app.meetingFollowThrough.minutes.tick();
  const pending=(await visible(people[1]))[0];
  assert.equal(pending.id,scheduled[0].id);
  released=true;
  await f.app.meetingFollowThrough.minutes.tick();
  const event = { minute_token:token, minute_source:{source_type:'meeting',source_entity_id:minute.meetingId} };
  await f.app.meetingFollowThrough.minutes.onMinuteGenerated(event);
  await f.app.meetingFollowThrough.minutes.tick();
  const pA=await visible(people[0]),pB=await visible(await f.login(1));
  assert.equal(pA.length,1); assert.equal(pB.length,1); assert.equal(pB[0].id,scheduled[0].id);
  assert.equal(pA[0].recordHref,pB[0].recordHref);
  assert.ok(pA[0].recordHref,JSON.stringify(pA));
  for(const cookie of [people[0],people[1]]) assert.match(ok(await f.call(cookie,'GET',pA[0].recordHref)).text,/业务负责人/);
  const legacy=`/api/meetings/${id}/transcript`;
  assert.ok(ok(await f.call(people[1],'GET',legacy)).turns.some((line:any)=>line.text.includes('业务负责人')));
  ok(await f.call(people[2],'GET',pA[0].recordHref),404);
  assert.deepEqual(await visible(people[2]),[]); assert.deepEqual(await visible(people[3]),[]);
  const book = async (when:Date) => ok(await f.call(people[0],'POST','/api/meetings',{title:ambiguous.title,
    scheduledAt:when.toISOString(),endsAt:new Date(+when+8*60_000).toISOString(),participants:[actors[1].personId],anchors:[{kind:'unit',id:'qa-capability'}]})).card;
  const nearby1=(await book(new Date(+laterStart-60_000))).objectRef.id, nearby2=(await book(laterStart)).objectRef.id;
  const third=(await book(new Date(+laterStart+3*60_000))).objectRef.id;
  const action=async (meetingId:string,kind:string,input:unknown={})=>{
    const card=ok(await f.call(people[0],'GET',`/api/me/cards/meetings/${meetingId}`));
    const actionId=card.actions.find((act:any)=>act.actionType===kind)?.actionId; assert.ok(actionId,kind);
    return ok(await f.call(people[0],'POST','/api/actions/execute',{actionId,input}));
  };
  const rescheduled=new Date(+laterStart+75*60_000);
  await action(third,'meeting.reschedule',{scheduledAt:rescheduled.toISOString()});
  const checkedSchedule=ok(await f.call(people[1],'GET',base)).items.find((item:any)=>item.meetingId===third);
  assert.equal(checkedSchedule.at,rescheduled.toISOString());
  await action(third,'meeting.cancel');
  assert.ok(!ok(await f.call(people[1],'GET',base)).items.some((item:any)=>item.meetingId===third));
  clock.setTime(+laterStart+9*60_000); otherReleased=true;
  await f.app.meetingFollowThrough.minutes.tick();
  const before=await f.pool.query('SELECT minute_token FROM meetings WHERE id=ANY($1::uuid[])',[[nearby1,nearby2]]);
  assert.deepEqual(before.rows.map((r:any)=>r.minute_token),[null,null]);
  await f.app.meetingFollowThrough.minuteInbox.scan();
  const arrangement=ok(await f.call(people[0],'GET','/api/me/feishu-minutes')).minutes.find((item:any)=>item.minuteToken===ambiguous.token);
  assert.deepEqual(new Set(arrangement?.suggestions?.map((item:any)=>item.meetingId)),new Set([nearby1,nearby2]));
  const inboxId='feishu-minute:'+ambiguous.token;
  const only=ok(await f.call(people[0],'GET',base)).items.find((item:any)=>item.id===inboxId); assert.ok(only?.recordHref);
  assert.ok(!ok(await f.call(people[1],'GET',base)).items.some((item:any)=>item.id===inboxId));
  ok(await f.call(people[1],'GET',only.recordHref),404);
  const attach=`/api/me/feishu-minutes/${ambiguous.token}/attach`;
  ok(await f.call(people[1],'POST',attach,{meetingId:nearby2}),404);
  assert.equal(ok(await f.call(people[0],'POST',attach,{meetingId:nearby2})).meetingId,nearby2);
  await f.app.meetingFollowThrough.minuteInbox.ingestQueued({minuteToken:ambiguous.token});
  const next=ok(await f.call(people[1],'GET',base)).items;
  const other=next.find((item:any)=>item.meetingId===nearby2);assert.ok(other?.recordHref,JSON.stringify(next));
  assert.equal(next.find((item:any)=>item.meetingId===nearby1)?.recordHref,null);
  assert.match(ok(await f.call(people[1],'GET',other.recordHref)).text,/只复核第二场/);
  assert.ok(!ok(await f.call(people[0],'GET',base)).items.some((item:any)=>item.id===inboxId));
  console.log(JSON.stringify({sameTitleNeighborsNotAutomaticallyBound:true,ownerOnlyUnmatched:true,ownerSelectedSecondMeeting:true,rescheduleAndCancelReflected:true}));
  await f.pool.query('DELETE FROM feishu_user_tokens WHERE person_id=$1', [actors[1].personId]);
  const revoked=await f.call(people[1],'GET',pB[0].recordHref);
  assert.equal(revoked.statusCode,403,revoked.body);
  assert.equal((await f.call(people[1],'GET',legacy)).statusCode,404);
  console.log(JSON.stringify({meetingPassed:true, pollRecovered:true, eventReplayDeduped:true, loginAgainRetainsReceipt:true,
    twoRecipientsReadContent:true,sourceAccessRevoked:revoked.statusCode,outsider:404,provider:'fixture',readersUsed:reads }));
} finally {await f.close();}
