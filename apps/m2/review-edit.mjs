const isFactsCard=n=>Array.isArray(n.facts);
const plain=t=>String(t||'');
// Editing reads like the page (评测 2026-10-22): no ** and no [E#] in the box. A line left as it was keeps its original
// text; a changed line gets its 短标题 bold again and keeps the evidence numbers it had.
const evidenceOf=t=>(String(t||'').match(/\[E\d+\]/g)||[]).join('');
const toEdit=t=>String(t||'').replace(/\*\*/g,'').replace(/\s*(\[E\d+\])+/g,'').trim();
const fromEdit=(line,orig)=>{if(orig!=null&&line===toEdit(orig))return orig;const m=line.match(/^([^：:]{1,24})[：:]\s*(.*)$/),body=m?`**${m[1]}：**${m[2]}`:line,ev=evidenceOf(orig);return ev?`${body} ${ev}`:body;};
export function startValues(n){if(isFactsCard(n))return {verdict:n.verdict||'未达成',verdictReason:toEdit(plain(n.verdictReason)),facts:n.facts.map(f=>({status:f.status||'未达成',evidence:toEdit(f.evidence),gap:toEdit(f.gap)})),next:(n.nextInputs||[]).map(x=>({type:x.type||'继续',text:toEdit(x.text)}))};return {verdict:n.verdict||'未达成',verdictReason:toEdit(plain(n.verdictReason)),targets:(n.targets||[]).map(toEdit).join('\n'),causes:(n.causes||[]).map(c=>toEdit(c.text)).join('\n'),nextInputs:(n.nextInputs||[]).map(x=>toEdit(x.text)).join('\n'),...(n.ltoReview?{ltoChoice:String(n.ltoReview.choice).startsWith('建议')?n.ltoReview.choice:'建议'+n.ltoReview.choice,ltoReason:plain(n.ltoReview.reason)}:{})};}
export function patchFrom(n,v){const lines=t=>String(t).split('\n').map(x=>x.trim()).filter(Boolean),out={};
 if(v.verdict!==n.verdict)out.verdict=v.verdict;if(v.verdictReason.trim()!==toEdit(plain(n.verdictReason)))out.verdictReason=fromEdit(v.verdictReason.trim(),n.verdictReason);
 if(isFactsCard(n)){const facts=n.facts.map((f,i)=>{const e=v.facts[i];return {...f,status:e.status,evidence:e.evidence.trim()===toEdit(f.evidence)?f.evidence:e.evidence.trim(),gap:e.gap.trim()===toEdit(f.gap)?f.gap||'':e.gap.trim()};});if(JSON.stringify(facts)!==JSON.stringify(n.facts))out.facts=facts;
  const next=(n.nextInputs||[]).map((x,i)=>({...x,type:v.next[i].type,text:v.next[i].text.trim()===toEdit(x.text)?x.text:v.next[i].text.trim()}));if(JSON.stringify(next)!==JSON.stringify(n.nextInputs||[]))out.nextInputs=next;return out;}
 const targets=lines(v.targets).map((t,i)=>fromEdit(t,(n.targets||[])[i]));if(JSON.stringify(targets)!==JSON.stringify(n.targets||[]))out.targets=targets;
 const causes=lines(v.causes).map((text,i)=>({text:fromEdit(text,(n.causes||[])[i]?.text),ask:(n.causes||[])[i]?.ask||''}));if(JSON.stringify(causes)!==JSON.stringify(n.causes||[]))out.causes=causes;
 const next=lines(v.nextInputs).map((text,i)=>({id:(n.nextInputs||[])[i]?.id||`${n.ref}-${i+1}`,type:(n.nextInputs||[])[i]?.type||'欠账',text:fromEdit(text,(n.nextInputs||[])[i]?.text)}));if(JSON.stringify(next)!==JSON.stringify(n.nextInputs||[]))out.nextInputs=next;
 if(n.ltoReview&&(v.ltoChoice!==n.ltoReview.choice||v.ltoReason.trim()!==plain(n.ltoReview.reason)))out.ltoReview={choice:v.ltoChoice,reason:v.ltoReason.trim()};
 return out;}

export function reviewEditRequest(baseline,current,values){
 if(baseline.id!==current.id||baseline.version!==current.version)throw Object.assign(Error('内容已更新，输入已保留，请核对最新版本。'),{status:409});
 return {type:'revise',cardId:baseline.id,baseVersion:baseline.version,patch:patchFrom(baseline,values)};
}
