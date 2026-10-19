import {plainCardTitle} from './reader-view.mjs';
// Display-only reading of a Task's 前置依赖 text: which sibling Task it waits on, and how many outside ones.
// Forms seen: 「同 Mission 任务名」：…, Domain「外部名」：…, **短标题：**「名」…, 任务名：…
export function dependencyName(entry){
 const s=String(entry||'').trim().replace(/^\*\*[^*]{1,16}?[：:]\*\*\s*/,'');
 const own=s.match(/^「([^」]+)」/);if(own)return {name:own[1].trim(),prefixed:false};
 const other=s.match(/^([^「」：:\s]{1,24})「([^」]+)」/);if(other)return {name:other[2].trim(),prefixed:true};
 const plain=s.match(/^([^「」：:*]{2,24})[：:]/);if(plain)return {name:plain[1].trim(),prefixed:false};
 return null;
}
const endOf=n=>{const d=String(n.time||'').match(/\d{4}-\d{2}-\d{2}/g);return d?Date.parse(d.at(-1)):0;};
export function taskDependencies(task,siblings){
 const byName=new Map();siblings.filter(s=>s.id!==task.id).forEach(s=>{byName.set(String(s.title||'').trim(),s);byName.set(plainCardTitle(s),s);});
 const internal=[];let external=0;
 for(const entry of task.dependsOn||[]){
  const r=dependencyName(entry);if(!r)continue;
  const hit=!r.prefixed&&byName.get(r.name);
  if(hit){if(!internal.includes(hit))internal.push(hit);}else external++;
 }
 // Only the nearest earlier-listed predecessor is drawn: arrows always point down the list, parallel Tasks that
 // cite each other never form a loop, and the chart does not turn into a web of lines.
 const at=x=>siblings.indexOf(x),self=at(task);
 const nearest=internal.filter(x=>self<0||at(x)<self).reduce((a,b)=>!a||endOf(b)>endOf(a)?b:a,null);
 return {internal,external,nearest};
}
