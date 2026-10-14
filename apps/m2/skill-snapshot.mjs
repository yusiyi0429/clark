import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function loadSkillSnapshot(root){
 // Evaluation answers and historical cases must not enter a blind generation.
 const generationReferences=new Set(['contracts.md','quality-bars.md','method.md','feasibility.md','templates.md','reader-format.md','revision-loop.md','organization-context.md','validation.md']);
 const paths=['SKILL.md',...(await readdir(new URL('references/',root))).filter(p=>generationReferences.has(p)).sort().map(p=>'references/'+p)];
 const files=await Promise.all(paths.map(async path=>{const content=await readFile(new URL(path,root),'utf8');return {path,content,hash:createHash('sha256').update(content).digest('hex')};}));
 const rules=files.map(f=>`\n--- ${f.path} ---\n${f.content}`).join('\n');
 const version=files[0].content.match(/(?:version|版本)\s*[:：]?\s*["']?([\d.]+)/i)?.[1]||'未标明';
 const content=await readFile(new URL('scripts/validate_schedule.py',root),'utf8');
 const scheduleValidator={content,hash:createHash('sha256').update(content).digest('hex')};
 return {rules,version,hash:createHash('sha256').update(rules).digest('hex'),files:files.map(({path,hash})=>({path,hash})),scheduleValidator,loadedAt:new Date().toISOString()};
}
