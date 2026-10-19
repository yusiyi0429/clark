// Display-only: what a revision proposal actually changes, item by item, so the owner sees the edit at a glance.
const items=v=>Array.isArray(v)?v.map(String):String(v??'').split('\n').filter(x=>x.trim());
export function stripMarks(s){return String(s??'').replace(/\*\*/g,'');}
// Within one changed sentence: the shared start and end, and the part that actually changed.
export function inlineChange(before,after){
 const a=[...String(before??'')],b=[...String(after??'')];let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;
 let end=0;while(end<a.length-start&&end<b.length-start&&a[a.length-1-end]===b[b.length-1-end])end++;
 // Widen to whole tokens so a date or number reads "10/22 → 10/24", not a lone digit.
 const word=/[0-9A-Za-z/.:%-]/;while(start>0&&word.test(b[start-1])&&(word.test(a[start]??'')||word.test(b[start]??'')))start--;
 while(end>0&&word.test(b[b.length-end])&&(word.test(a[a.length-end-1]??'')||word.test(b[b.length-end-1]??'')))end--;
 return {head:b.slice(0,start).join(''),removed:a.slice(start,a.length-end).join(''),added:b.slice(start,b.length-end).join(''),tail:b.slice(b.length-end).join('')};
}
// Returns rows in display order; unchanged rows are kept so the caller can fold them.
export function proposalRows(before,after){
 const a=items(before),b=items(after),rows=[],n=Math.max(a.length,b.length);
 for(let i=0;i<n;i++){
  if(i>=a.length)rows.push({kind:'added',after:b[i]});
  else if(i>=b.length)rows.push({kind:'removed',before:a[i]});
  else rows.push(a[i]===b[i]?{kind:'same',after:b[i]}:{kind:'changed',before:a[i],after:b[i]});
 }
 return rows;
}
// One line saying what a proposal does to each field, e.g. "里程碑：改 1 条 · 约束与依赖：增 1 条".
export function changeSummary(before,after){
 const rows=proposalRows(before,after),n=k=>rows.filter(r=>r.kind===k).length;
 const single=!Array.isArray(before)&&!Array.isArray(after)&&rows.length<=1;
 if(single)return '改写';
 return [n('changed')&&`改 ${n('changed')} 条`,n('added')&&`增 ${n('added')} 条`,n('removed')&&`删 ${n('removed')} 条`].filter(Boolean).join('、')||'无变化';
}
