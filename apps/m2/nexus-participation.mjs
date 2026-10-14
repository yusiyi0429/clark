// Participation is based on new public events, never a historical mention.
export const quietWindowMs=20000;
export const interventionCooldownMs=120000;
export function directQuestion(e){
 return /[@＠]\s*(Nexus|Co[- ]?agent)/i.test(e.text)||/(Nexus|Co[- ]?agent)[，,：:\s]*(请|帮|你|怎么看|是否|能否|总结|整理|核对|分析|回答)/i.test(e.text)||e.replyToAuthor==='Nexus';
}
export function participationDecision(value,{fresh=[],manual=false,lastIntervention,now=Date.now()}){
 const called=manual||fresh.some(directQuestion);
 const reason=String(value.interventionReason||'').trim();
 const reliable=value.interventionNeeded===true&&['risk','clarification'].includes(value.interventionType)&&reason&&Array.isArray(value.interventionSourceIds)&&value.interventionSourceIds.some(id=>fresh.some(e=>e.id===id));
 const key=String(value.interventionKey||reason).trim().slice(0,180);
 const cooling=lastIntervention&&now-Date.parse(lastIntervention.at)<interventionCooldownMs;
 const duplicate=lastIntervention?.key===key&&lastIntervention.sourceIds?.every(id=>fresh.some(e=>e.id===id));
 return {speak:!!(called||reliable&&!cooling&&!duplicate),called,key,sourceIds:fresh.map(e=>e.id),reason};
}
