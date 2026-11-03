import React,{useRef,useState,useId} from 'react';
import {Button} from '@heroui/react';
import {Plus,Mic,ArrowUp,X} from 'lucide-react';
import {enterSubmit} from './enter-submit.mjs';
import {mentionAt,insertMention} from './mention-input.mjs';
import MemberAvatar from './MemberAvatar.jsx';
import {NexusOrb} from './NexusIsland.jsx';

export default function ChatComposer({text,onChange,onSend,onVoice,recording,busy,channel,reply,onCancelReply,members=[],roomName='规划群',disabled=false,draftKey,draftCache}){
 const picker=useRef(),[attachment,setAttachment]=useState(()=>draftCache?.current[draftKey]||null),[notice,setNotice]=useState('');
 const sendFlight=useRef(false),input=useRef(),lastQuery=useRef('null'),listId=useId(),[mention,setMention]=useState(null),[active,setActive]=useState(0);
 const choices=channel==='group'&&mention?['Nexus',...members].filter((name,index,all)=>all.indexOf(name)===index&&name.toLowerCase().includes(mention.query.toLowerCase())):[];
 const selected=Math.min(active,Math.max(0,choices.length-1));
 function saveAttachment(value){if(draftCache&&draftKey)draftCache.current[draftKey]=value;setAttachment(value);}
 function track(event){const value=event.target.value,next=channel==='group'?mentionAt(value,event.target.selectionStart):null,key=JSON.stringify(next);if(key===lastQuery.current)return;lastQuery.current=key;setMention(next);setActive(0);}
 function chooseMention(name){
  const result=insertMention(text,mention,name);onChange(result.value);setMention(null);
  requestAnimationFrame(()=>{input.current?.focus();input.current?.setSelectionRange(result.caret,result.caret);});
 }
 function keyDown(event){
  if(choices.length&&!event.nativeEvent?.isComposing&&event.keyCode!==229){
   if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setActive((selected+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length);return;}
   if(event.key==='Escape'){event.preventDefault();setMention(null);return;}
   if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!event.repeat)chooseMention(choices[selected]);return;}
  }
  enterSubmit(event,submit,!disabled&&!busy&&!recording);
 }
 async function selectFile(event){
  const file=event.target.files?.[0];event.target.value='';if(!file)return;
  if(!/\.(txt|md|csv|json)$/i.test(file.name)||file.size>24000){setNotice('目前支持小型 TXT、Markdown、CSV 和 JSON 文本附件。');return;}
  const content=await file.text();
  if(content.length>6000){setNotice('附件内容请控制在 6000 字以内。');return;}
  saveAttachment({name:file.name,content});setNotice('');
 }
 async function submit(){
  const value=[text.trim(),attachment?`附件：${attachment.name}\n${attachment.content}`:''].filter(Boolean).join('\n\n');
  if(!value||disabled||busy||recording||sendFlight.current)return;
  if(value.length>8000){setNotice('消息和附件合计不能超过 8000 字。');return;}
  sendFlight.current=true;try{if(await onSend(value,channel,{draftText:text})!==false){saveAttachment(null);setNotice('');}}finally{sendFlight.current=false;}
 }
 return <div className="composer" aria-label={channel==='agent'?'私人 Agent 输入':'规划群输入'}>
  {channel==='group'&&reply&&<div className="compose-reply"><div><small>回复 {reply.author}</small><p>{reply.text.slice(0,120)}</p></div><Button className="icon" aria-label="取消引用回复" onPress={onCancelReply}><X size={14}/></Button></div>}
  {attachment&&<div className="compose-attachment"><span>{attachment.name}</span><Button className="icon" aria-label="移除附件" onPress={()=>saveAttachment(null)}><X size={14}/></Button></div>}
  {!!choices.length&&<div className="mention-picker" id={listId} role="listbox" aria-label="选择要提及的成员">{choices.map((name,i)=><button type="button" role="option" aria-label={name} id={`${listId}-${i}`} aria-selected={i===selected} key={name} onMouseDown={e=>e.preventDefault()} onClick={()=>chooseMention(name)}>{name==='Nexus'?<NexusOrb/>:<MemberAvatar name={name}/>} {name}</button>)}</div>}
  <textarea disabled={disabled} ref={input} aria-label="消息" aria-autocomplete={channel==='group'?'list':undefined} aria-controls={choices.length?listId:undefined} aria-expanded={choices.length>0} aria-activedescendant={choices.length?`${listId}-${selected}`:undefined} title="回车发送，Shift＋回车换行" onKeyDown={keyDown} onSelect={track} onBlur={()=>setMention(null)} value={text} onChange={event=>{onChange(event.target.value);track(event);}} placeholder={recording?'正在聆听…':channel==='agent'?'和 Agent 讨论…':`发送到${roomName}…`}/>
  <div className="compose-tools">
   <input ref={picker} type="file" accept=".txt,.md,.csv,.json" disabled={disabled} hidden onChange={selectFile}/>
   <Button className="icon attachment-button" isDisabled={disabled} aria-label="添加附件" onPress={()=>picker.current?.click()}><Plus size={22}/></Button>
   <Button className={`icon voice ${recording?'recording':''}`} aria-label={recording?'结束语音输入':'开始语音输入'} aria-pressed={recording} isDisabled={disabled} onPress={onVoice}><Mic size={21}/></Button>
   <Button className="send" aria-label="发送" isDisabled={disabled||(!text.trim()&&!attachment)||busy||recording} onPress={submit}><ArrowUp size={21}/></Button>
  </div>
  {notice&&<p className="compose-notice" role="alert">{notice}</p>}
 </div>;
}
