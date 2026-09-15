import { describe,expect,it } from 'vitest';
import { UNKNOWN_SPEAKER,activeSpeakerIds,initialSpeakerAssignments,validateSpeakerAssignments } from './meeting-speakers';

const utterances=[
  {idx:1,speakerId:'b',startMs:1000,endMs:1500,text:'第二句'},
  {idx:0,speakerId:'a',startMs:0,endMs:900,text:'第一句'},
  {idx:2,speakerId:'a',startMs:1600,endMs:2000,text:'第三句'},
];

describe('meeting speaker confirmation',()=>{
  it('orders speakers by first utterance and restores only known names',()=>{
    expect(activeSpeakerIds(utterances)).toEqual(['a','b']);
    expect(initialSpeakerAssignments(utterances,[{speakerId:'a',displayName:'刘明华'},{speakerId:'b',displayName:'陌生人'}],['刘明华','白田田'])).toEqual({a:'刘明华',b:''});
  });
  it('requires a unique CEO mapping while allowing an unknown voice',()=>{
    expect(validateSpeakerAssignments(['a','b'],{a:'刘明华',b:UNKNOWN_SPEAKER},'刘明华')).toBeNull();
    expect(validateSpeakerAssignments(['a','b'],{a:'白田田',b:UNKNOWN_SPEAKER},'刘明华')).toContain('必须先确认');
    expect(validateSpeakerAssignments(['a','b'],{a:'刘明华',b:'刘明华'},'刘明华')).toContain('不能对应两个声源');
  });
});
