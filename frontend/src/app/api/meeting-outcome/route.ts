import { NextResponse } from 'next/server';
import { callJson,parseJson } from '@/lib/agent/json';
import { MEETING_OUTCOME_SYSTEM_PROMPT,normalizeMeetingOutcome,type MeetingOutcomeInput } from '@/lib/warmap/meeting-outcome';

export const runtime='nodejs';
export const maxDuration=120;

export async function POST(request:Request){
  const raw=await request.text();
  if(raw.length>220_000)return NextResponse.json({error:'这份逐字稿超过了单次提炼上限，请先分段。'},{status:413});
  try{
    const input=JSON.parse(raw) as MeetingOutcomeInput;
    if(!input.meetingId||!input.recordingId||!input.transcriptUpdatedAt||!input.title||!input.leadDri||!input.ceoName||!Array.isArray(input.participants)||!input.transcript?.trim())throw new Error('missing input');
    if(process.env.TKOS_MODEL_MOCK==='1')return NextResponse.json({error:'离线演练不生成会议事实。录音和逐字稿仍会保留。'},{status:503});
    const answer=await callJson([
      {role:'system',content:MEETING_OUTCOME_SYSTEM_PROMPT},
      {role:'user',content:JSON.stringify({...input,transcript:input.transcript.slice(0,200_000)})},
    ],{slot:'pro',maxTokens:6000,timeoutMs:110_000,hint:'warmap.meeting-outcome'});
    return NextResponse.json(normalizeMeetingOutcome(parseJson(answer),input));
  }catch(error){
    console.error('[meeting-outcome] 提炼失败：',error);
    return NextResponse.json({error:'这场会暂时没有提炼完成；逐字稿已保留，可以稍后重试。'},{status:503});
  }
}
