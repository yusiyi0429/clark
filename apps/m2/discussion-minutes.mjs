// Derive minutes only from the current room's shared projection, never private chats.
const brief=value=>String(value||'').replace(/[@＠]\s*(Nexus|Co[- ]?agent)[，,：:\s]*/ig,'').replace(/\s+/g,' ').replace(/[。；;？！?!]+$/,'').trim().slice(0,90);
export function minuteSentence(topic){
 const names=[...new Set((topic.evidence||[]).map(r=>r.author))];
 const who=names.length>3?names.slice(0,2).join('、')+'等':names.join('、')||'参与者';
 const content=brief(topic.status==='agreement'?topic.conclusion||topic.title:topic.title);
 if(topic.stale)return `${who}讨论的“${content}”需按新材料重新核对。`;
 if(topic.status==='agreement')return `${who}已达成一致：${content}。`;
 if(topic.status==='discussing')return `${who}正在讨论：${content}。`;
 if(/^(hi|hello|你好|测试)[!！。\s]*$/i.test(content))return `${who}发言“${content}”，尚未提出具体观点。`;
 return `${who}提出：${content}。`;
}
export function waitingSentence(topic){
 const w=topic.waiting;
 if(!w||topic.status==='agreement')return '';
 if(topic.stale)return '材料版本已变化，先重新核对等待条件。';
 return `等${w.recipient}补充：${w.missing}。再检查的条件：${w.recheckWhen}。`;
}
export function discussionMinutes(topics=[],records=[],drafts={}){
 const sources=new Map(records.filter(r=>r.channel==='group'&&r.kind!=='revision-proposal'&&!['Nexus','Agent','system'].includes(r.author)).map(r=>[r.id,r]));
 const sections={agreement:[],discussing:[],pending:[]};
 for(const topic of topics){
  const evidence=(topic.sourceIds||[]).map(id=>sources.get(id)).filter(Boolean);
  const cardId=topic.waiting?.cardId||topic.anchor?.cardId,card=drafts[cardId];
  const stale=!!card&&(topic.waiting&&topic.waiting.baseVersion!==card.version||evidence.some(r=>r.context?.selection?.id===cardId&&r.context.selection.version!==card.version));
  const status=stale?'discussing':topic.status==='agreement'?'agreement':topic.status==='pending'?'pending':'discussing';
  sections[status].push({...topic,status,stale,evidence});
 }
 return {...sections,proposals:records.filter(r=>r.kind==='revision-proposal')};
}
