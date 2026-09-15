import type { RecordingSpeaker, RecordingUtterance } from '@/lib/recording/types';

export const UNKNOWN_SPEAKER = '__unknown__';

export function activeSpeakerIds(utterances:RecordingUtterance[]):string[] {
  const ids:string[]=[];
  for(const utterance of [...utterances].sort((a,b)=>a.idx-b.idx)){
    if(!ids.includes(utterance.speakerId))ids.push(utterance.speakerId);
  }
  return ids;
}

export function initialSpeakerAssignments(
  utterances:RecordingUtterance[],
  speakers:RecordingSpeaker[],
  participants:string[],
):Record<string,string> {
  const known=new Set(participants);
  return Object.fromEntries(activeSpeakerIds(utterances).map(id=>{
    const name=speakers.find(speaker=>speaker.speakerId===id)?.displayName?.trim()||'';
    return [id,known.has(name)?name:''];
  }));
}

export function validateSpeakerAssignments(
  speakerIds:string[],
  assignments:Record<string,string>,
  ceoName:string,
):string|null {
  const missing=speakerIds.filter(id=>!assignments[id]);
  if(missing.length)return '请为每个声源选择参会人，无法判断的可标记为“未确认”。';
  const named=speakerIds.map(id=>assignments[id]).filter(name=>name!==UNKNOWN_SPEAKER);
  if(new Set(named).size!==named.length)return '同一位参会人不能对应两个声源，请重新核对。';
  if(!named.includes(ceoName))return `必须先确认哪一个声源是 ${ceoName}，才能提炼需要 CEO 确认的判断。`;
  return null;
}

export function speakerSamples(utterances:RecordingUtterance[],speakerId:string,limit=3):string[] {
  return utterances.filter(item=>item.speakerId===speakerId&&item.text.trim()).slice(0,limit).map(item=>item.text.trim());
}
