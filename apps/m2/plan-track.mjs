// Display-only geometry for the Plan timeline: one track per row, positioned on the week columns.
// Each week column has the same width, so a date maps to (week index + offset inside that week) / weeks.
const DAY=864e5;
function position(weeks,at,edge){
 if(!weeks.length)return 0;
 if(at<weeks[0].from)return 0;
 const i=weeks.findIndex(w=>at>=w.from&&at<=w.to);if(i<0)return 100;
 const w=weeks[i],days=Math.round((w.to-w.from)/DAY)+1,offset=Math.round((at-w.from)/DAY)+(edge==='start'?0:edge==='end'?1:.5);
 return (i+offset/days)/weeks.length*100;
}
export function shortLabel(referenceLabel){return String(referenceLabel||'').replace(/^Mission\s*/,'M').replace(/^Task\s*/,'T').replace(/^Activity\s*/,'A');}
// span: [startMs,endMs] or null; gates: [{at,label}]. Returns percentages for the bar, the path and each node.
export function planTrack(weeks,span,gates){
 const bar=span?{left:position(weeks,span[0],'start'),right:position(weeks,span[1],'end')}:null;
 const points=[...gates].sort((a,b)=>a.at-b.at).map(g=>{const d=new Date(g.at);return {pct:position(weeks,g.at,'mid'),label:g.label,date:`${d.getUTCMonth()+1}/${d.getUTCDate()}`};});
 // At most two names per row so they never pile up: the final result always, plus the earliest node whose
 // name fits beside it on the same line. Every other node stays a dot; its name is in the tooltip.
 // Widths are estimated in % of a ~420px track (10px text): "10/20 " ≈ 8.5%, each character ≈ 2.6%.
 const width=p=>8.5+[...String(p.label||'')].length*2.6;
 const extent=p=>p.align==='end'?[p.pct-width(p),p.pct]:p.align==='start'?[p.pct,p.pct+width(p)]:[p.pct-width(p)/2,p.pct+width(p)/2];
 const last=points.at(-1);
 if(last)last.align=last.pct+width(last)/2>100?'end':'middle';
 const first=points.slice(0,-1).find(p=>{p.align=p.pct-width(p)<0?'start':'end';return extent(p)[1]+2<=extent(last)[0];});
 points.forEach((p,i)=>{p.last=i===points.length-1;p.labeled=p===last||p===first;p.lane='below';});
 const path=points.length>1?{left:points[0].pct,right:points.at(-1).pct}:null;
 return {bar,points,path};
}
export const datePosition=position;
// Gantt 名称 column width when dragged: at least 180px, and the weeks keep at least 12px a day.
export function clampNameCol(width,canvasWidth=Infinity){
 const max=Math.max(180,Math.min(760,canvasWidth-31*12));
 return Math.round(Math.min(max,Math.max(180,Number(width)||180)));
}
