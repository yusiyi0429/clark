// Sensitive personal details are hidden before any text reaches the model (模型调用稳定性加固, 陈溪南 2026-10-22):
// a sentence naming pay, background checks, IDs, personal ratings or health is replaced; mechanisms, progress and results stay.
// sensitive-rules.json here is the one shared list (review, decoding, Nexus).
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const rulesFile=JSON.parse(readFileSync(new URL('./sensitive-rules.json',import.meta.url),'utf8'));
const rules=rulesFile.rules.map(r=>({name:r.name,placeholder:r.placeholder,re:new RegExp(r.pattern,'i')}));
export const sensitiveRulesVersion=rulesFile.version;

// Splits after each ，,。；！？ and line break, so a replaced sentence keeps its own punctuation.
export function redactText(text){
 const hits={};let changed=false;
 const out=String(text??'').split(/(?<=[，,。；;！!？?\n])/).map(part=>{
  const rule=rules.find(r=>r.re.test(part));if(!rule)return part;
  hits[rule.name]=(hits[rule.name]||0)+1;changed=true;
  const tail=part.match(/[，,。；;！!？?\n]$/)?.[0]||'';return rule.placeholder+tail;
 }).join('');
 return {text:changed?out:String(text??''),hits};
}
const add=(into,hits)=>{for(const [k,n] of Object.entries(hits))into[k]=(into[k]||0)+n;return into;};

// Redacts each fact and rebuilds the unit text the model reads; returns the counts per unit for the round's audit.
export function redactSources(sources){
 const byUnit={},total={};
 const out=sources.map(s=>{
  const unit={};
  const facts=(s.facts||[]).map(f=>{const r=redactText(f.text);add(unit,r.hits);return Object.keys(r.hits).length?{...f,text:r.text,redacted:r.hits}:f;});
  let content;
  if(s.facts?.length&&Object.keys(unit).length)content=facts.map(f=>`${f.kind==='intent'?'【本月意图】':''}${f.title||f.kind} · ${f.sourceRef} · ${f.confirmation}${f.factThrough?' · 事实截至'+f.factThrough:''}\n${f.text}`).join('\n\n');
  else if(!s.facts?.length){const r=redactText(s.content);add(unit,r.hits);content=Object.keys(r.hits).length?r.text:undefined;}
  if(!Object.keys(unit).length)return s;
  byUnit[s.key]=unit;add(total,unit);
  return {...s,facts,content,hash:createHash('sha256').update(content).digest('hex')};
 });
 return {sources:out,redactions:{rules:sensitiveRulesVersion,total,byUnit}};
}

// Chat calls (Nexus, private Agent; UIUX 2026-10-22): every message the model sees, with the counts of what was hidden.
export function redactMessages(messages){
 const counts={};
 const next=messages.map(m=>{if(typeof m.content!=='string')return m;const r=redactText(m.content);add(counts,r.hits);return Object.keys(r.hits).length?{...m,content:r.text}:m;});
 return {messages:next,counts};
}
