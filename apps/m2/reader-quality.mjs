// Count visible characters, not bytes or English words. Never shorten values here.
import {templateFields} from './document-template.mjs';
export function visibleLength(value){
 const text=String(value??'').replace(/^\s*(?:\d+[.、．)]|[-+*])\s+/gm,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/\*\*|__|`|(?<!\*)\*(?!\*)/g,'').replace(/\s/g,'');
 return [...text].length;
}
// Read limits from the frozen reader rules. Old rounds keep their old policy.
export function readerPolicy(rules=''){
 const row=label=>rules.split('\n').find(line=>line.startsWith('| '+label+' |'))||'';
 const numbers=label=>[...row(label).matchAll(/(\d+)字/g)].map(m=>Number(m[1]));
 // One number governs both; a second number, when the skill gives one, governs point headings (2.0.6: Card 20, point 12).
 const [title,heading=title]=numbers('Card短标题、分点短标题'),result=numbers('成果描述／工作结果／预期产出')[0];
 const [field,point]=numbers('存在必要性、责任边界、核心路径、关键取舍、约束与依赖');
 const [checks,checkPoint]=numbers('验收标准'),summary=numbers('上级Plan中的下级成果摘要')[0];
 return [title,result,field,point,checks,checkPoint,summary].every(n=>Number.isInteger(n)&&n>0)?{title,heading,result,field,point,checks,checkPoint,summary}:null;
}
export function readerQuality(unit,policy){
 if(!policy)return [];
 const issues=[];
 const labels={title:'标题',result:'成果描述',why:'存在必要性',boundary:'责任边界',logic:'核心路径',path:'核心路径',tradeoff:'关键取舍',dependencies:'约束与依赖',checks:'验收标准',milestones:'里程碑'};
 const visit=(node,path,cardReference,level)=>{
  const template=templateFields[level],shown=new Set([...template.core,...template.detail,...(template.plan||[])].map(([field])=>field));
  const add=(field,actual,limit,problem='超过字数上限')=>{const base=field.split('[')[0],index=field.match(/\[(\d+)\]/);issues.push({unitKey:unit.key,cardTitle:node.title,cardReference,fieldLabel:`${labels[base]||base}${index?`第${Number(index[1])+1}点`:''}${field.endsWith('.heading')?'短标题':''}`,fieldPath:`${path}.${field}`,problem,actual,limit,impact:'影响阅读；保留完整原文，不截断，不判为达标',repairable:true});};
  if(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|^(?:候选\s*[：:]\s*)?(?:PO|Mission|Task)\s*[：:]/i.test(node.title))add('title',visibleLength(node.title),policy.title,'标题夹带日期或对象前缀');
  if(/^\s*候选\s*[：:]/.test(node.result)||/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|(?<![A-Za-z\d])(?:1[0-2]|0?[1-9])\/(?:[12]\d|3[01]|0?[1-9])(?!\d)/.test(node.result))add('result',visibleLength(node.result),policy.result,'成果夹带候选前缀或日期，需在技能输出中检查字段分工');
  for(const [field,limit]of [['title',policy.title],['result',policy.result]])if(visibleLength(node[field])>limit)add(field,visibleLength(node[field]),limit);
  for(const [i,milestone]of (shown.has('milestones')?node.milestones||[]:[]).entries()){
   const match=String(milestone).match(/^\s*(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})\s+(.+)$/);
   if(match&&visibleLength(match[4])>10)add(`milestones[${i}]`,visibleLength(match[4]),10,'里程碑标签超过10字');
  }
  for(const field of ['why','boundary','logic','path','tradeoff','dependencies','checks']){
   if(!shown.has(field))continue;
   if(node[field]==null)continue;
   const points=Array.isArray(node[field])?node[field]:[node[field]],total=points.reduce((sum,p)=>sum+visibleLength(p),0),limit=field==='checks'?policy.checks:policy.field;
   if(total>limit)add(field,total,limit);
   points.forEach((p,i)=>{
    const max=field==='checks'?policy.checkPoint:policy.point,length=visibleLength(p);
    if(length>max)add(`${field}[${i}]`,length,max);
    const match=String(p).match(/^\s*\*\*([^\n]+?[：:])\*\*(.+)$/s);
    if(!match||match[2].includes('**'))add(`${field}[${i}]`,length,max,'分点应为加粗短标题加普通正文');
    else if(visibleLength(match[1].replace(/[：:]$/,''))>(policy.heading??policy.title))add(`${field}[${i}].heading`,visibleLength(match[1].replace(/[：:]$/,'')),policy.heading??policy.title);
   });
  }
  for(const field of ['missions','tasks','activities'])for(const [i,child]of (node[field]||[]).entries())visit(child,`${path}.${field}[${i}]`,`${cardReference} / ${{missions:'Mission',tasks:'Task',activities:'Activity'}[field]} ${String(i+1).padStart(2,'0')}`,{missions:'mission',tasks:'task',activities:'activity'}[field]);
 };
 visit(unit,'unit','PO','po');return issues;
}
