// Human-view summaries never replace the underlying commitment or editing values.
export function readerSource(node){return JSON.stringify([node.title,node.result,node.milestones||[]]);}
export function readerView(node,views){const view=views?.[node.id];return view?.source===readerSource(node)?view:null;}
export function plainCardTitle(node){
 let title=String(node.title||'').replace(/^\s*\d{4}[-./]\d{1,2}[-./]\d{1,2}\s*[—–~至-]\s*\d{4}[-./]\d{1,2}[-./]\d{1,2}\s*/,'').replace(/^\s*(?:PO|Mission|Task)\s*[：:]\s*/i,'');
 if(node.level==='po'){
  const group=String(node.name||'').replace(/^(?:Battlefield|Domain)\s*(?:\d+\s*)?/,'');
  if(group&&title.startsWith(group))title=title.slice(group.length).replace(/^\s*[：:]\s*/,'').trim();
 }
 return title||node.title;
}
export function fieldPoints(value){
 const clean=s=>String(s).trim().replace(/^\d+[.、．]\s*/, '');
 if(Array.isArray(value))return value.map(clean).filter(Boolean);
 const text=String(value||'');
 // An explicit numbered list defines its own boundaries; semicolons inside a
 // point are part of the reasoning, not another point. Keep legacy separators.
 const numbered=/^\s*\d+[.、．]\s*/m.test(text);
 return text.split(numbered?/\n(?=\s*\d+[.、．]\s*)/:/\n|[；;]/).map(clean).filter(Boolean);
}
export function milestoneParts(entry){
 const iso=String(entry).match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
 if(iso)return {date:`${Number(iso[2])}/${Number(iso[3])}`,label:String(entry).replace(iso[0],'').replace(/^\s*[,，:：]\s*/,'').trim()};
 const match=String(entry).match(/^\s*(?:\*\*)?(\d{1,2}[./月]\d{1,2}(?:日)?)(?:\*\*)?\s*[：:]?\s*(.*)$/s);
 return match?{date:match[1],label:match[2]}:{date:'',label:String(entry)};
}
export function cleanCandidatePrefix(value){return typeof value==='string'?value.replace(/^\s*候选\s*[：:]\s*/,''):value;}
// 2026-10-01—2026-10-31 → 2026.10.1 – 10.31 (the end date drops a repeated year).
export function formatPlanDate(value){
 const dot=(y,m,d)=>`${y}.${Number(m)}.${Number(d)}`;
 return String(value||'')
  .replace(/(\d{4})-(\d{2})-(\d{2})\s*(?:[—–~至]|--?)\s*(\d{4})-(\d{2})-(\d{2})/g,(_,y1,m1,d1,y2,m2,d2)=>`${dot(y1,m1,d1)} – ${y1===y2?`${Number(m2)}.${Number(d2)}`:dot(y2,m2,d2)}`)
  .replace(/(\d{4})-(\d{2})-(\d{2})/g,(_,y,m,d)=>dot(y,m,d));
}
export function inheritedPlanField(node,field){
 if(node.level!=='po'||fieldPoints(node[field]).length)return null;
 if(field==='dependencies'){
  const value=(node.children||[]).flatMap((child,i)=>fieldPoints(child.dependencies).map(text=>`Mission ${String(i+1).padStart(2,'0')}：${text}`));
  return value.length?{value,source:'汇总自下属 Mission 的约束与依赖'}:null;
 }
 if(field==='milestones'){
  const value=(node.children||[]).flatMap(child=>{
   const original=child.milestones?.at(-1);if(!original)return [];
   const date=milestoneParts(original).date;
   const label=child.humanView?.milestones?.at(-1);return date&&label?[`${date} ${milestoneParts(label).label}`]:[];
  });
  return value.length?{value,source:'汇总自下属 Mission 的收尾里程碑'}:null;
 }
 return null;
}
// Display-only: a heading that already ends in punctuation must not get a second mark (“复制。：”).
export function trimTrailingPunct(value){return String(value??'').replace(/[\s。．.；;，,、：:]+$/,'');}
// A parent plan shows each child as one short line (skill reader-format: 下级成果摘要 ≤50 字).
// Take the first clause; if still long, cut at the last comma before the limit. Full text stays on the child card.
export function planSummary(value,limit=50){
 const text=String(value??'').trim();if(!text)return {text:'',truncated:false};
 const first=text.split(/[；;。]/)[0].trim()||text;
 if([...first].length<=limit)return {text:first,truncated:first!==text.replace(/[；;。\s]+$/,'')};
 const head=[...first].slice(0,limit).join(''),cut=Math.max(head.lastIndexOf('，'),head.lastIndexOf(','),head.lastIndexOf('、'));
 return {text:(cut>=limit*0.5?head.slice(0,cut):head)+'…',truncated:true};
}
