// Participation is based on new public events, never a historical mention.
export const quietWindowMs=20000;
export const interventionCooldownMs=120000;
// "改完了吗 / 还差什么 / 谁还没确认" asked to the group (not to a named person) is for Nexus to answer.
export function progressQuestion(e){const t=String(e.text||'');return /(改完了吗|改好了吗|都改了吗|进度|还差|还剩|到哪了|谁还没|都确认了吗|确认了吗|完成了吗|搞定了吗|还有什么没)/.test(t)&&!/[@＠](?!\s*(Nexus|Co[- ]?agent))/i.test(t);}
// A question written on a card (批注里的问题) is asked of Nexus unless it names someone else (陈溪南 2026-10-23).
export function cardQuestion(e){const t=String(e.text||'');return e.kind==='document-comment'&&/[？?]|啥|什么|为什么|为何|怎么|哪(个|些|里|条)|是不是|能不能|吗\s*$/.test(t)&&!/[@＠](?!\s*(Nexus|Co[- ]?agent))/i.test(t);}
export function directQuestion(e){
 return cardQuestion(e)||progressQuestion(e)||/[@＠]\s*(Nexus|Co[- ]?agent)/i.test(e.text)||/(Nexus|Co[- ]?agent)[，,：:\s]*(请|帮|你|怎么看|是否|能否|总结|整理|核对|分析|回答)/i.test(e.text)||e.replyToAuthor==='Nexus'||e.answersNexus===true||!!e.answers;
}
export function participationDecision(value,{fresh=[],manual=false,lastIntervention,now=Date.now()}){
 const called=manual||fresh.some(directQuestion);
 const reason=String(value.interventionReason||'').trim();
 // Mediation counts only when the model is highly confident its summary and proposal are right.
 const type=value.interventionType,confident=type!=='mediation'||value.interventionConfidence==='high';
 const reliable=value.interventionNeeded===true&&['risk','clarification','mediation'].includes(type)&&confident&&reason&&Array.isArray(value.interventionSourceIds)&&value.interventionSourceIds.some(id=>fresh.some(e=>e.id===id));
 const key=String(value.interventionKey||reason).trim().slice(0,180);
 const cooling=lastIntervention&&now-Date.parse(lastIntervention.at)<interventionCooldownMs;
 const duplicate=lastIntervention?.key===key&&lastIntervention.sourceIds?.every(id=>fresh.some(e=>e.id===id));
 // A reliable risk found during the cooldown is held, not dropped: the server re-checks it once the cooldown ends.
 const deferred=!called&&reliable&&cooling&&!duplicate;
 return {speak:!!(called||reliable&&!cooling&&!duplicate),called,key,sourceIds:fresh.map(e=>e.id),reason,deferred,deferUntil:deferred?Date.parse(lastIntervention.at)+interventionCooldownMs:null,deferIds:deferred?value.interventionSourceIds.filter(id=>fresh.some(e=>e.id===id)):[]};
}
