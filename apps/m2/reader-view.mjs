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
export function formatPlanDate(value){return String(value||'').replace(/(\d{4})-(\d{2})-(\d{2})/g,'$1 $2 $3').replace(/\s*[—–]\s*/g,' 至 ');}
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
