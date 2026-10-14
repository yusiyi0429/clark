import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export function dateSpan(value){
 const m=typeof value==='string'&&value.match(/^\s*(\d{4}-\d{2}-\d{2})(?:\s*(?:—|–|~|至|到|\s-\s)\s*(\d{4}-\d{2}-\d{2}))?\s*$/);
 if(!m)throw Error('日期必须是具体日期或区间，不能夹带说明');
 const dates=[m[1],m[2]||m[1]];
 if(dates.some(d=>!Number.isFinite(Date.parse(d))||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)||dates[0]>dates[1])throw Error('日期无效或开始晚于结束');
 return dates;
}
export function monthSpan(period){
 if(!/^\d{4}-\d{2}$/.test(period||''))throw Error('生成周期必须为 YYYY-MM');
 dateSpan(period+'-01');
 const last=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);
 return period+'-01—'+last;
}
export function synchronizeSchedule(unit,period){
 const replace=(node,value)=>{if(node.time!==value){node.generatedFieldSources??={};node.generatedFieldSources.time??=structuredClone(node.time??null);node.time=value;}};
 replace(unit,monthSpan(period));
 for(const mission of unit.missions||[]){
  const spans=(mission.tasks||[]).map(t=>{const span=dateSpan(t.time);for(const a of t.activities||[]){const s=dateSpan(a.time);if(s[0]<span[0]||s[1]>span[1])throw Error('Activity 超出所属 Task 日期');}return span;});
  if(spans.length)replace(mission,spans.map(s=>s[0]).sort()[0]+'—'+spans.map(s=>s[1]).sort().at(-1));
 }
 return unit;
}
export async function runSkillScheduleCheck(validator,plan){
 if(!validator?.content)throw Error('技能缺少排期检查脚本，未宣称检查通过');
 const dir=await mkdtemp(join(tmpdir(),'decoding-schedule-'));
 try{
  const script=join(dir,'validate_schedule.py'),file=join(dir,'plan.json');
  await writeFile(script,validator.content);await writeFile(file,JSON.stringify(plan));
  let stdout;
  try{({stdout}=await run(process.env.DECODING_PYTHON||'python3',[script,file],{timeout:30000,maxBuffer:1024*1024}));}
  catch(error){if(error.code!==1||!error.stdout)throw Error('排期检查无法运行：'+error.message);stdout=error.stdout;}
  return {...JSON.parse(stdout),validatorHash:validator.hash};
 }finally{await rm(dir,{recursive:true,force:true});}
}
