import {disagrees} from './stance.mjs';
const replace='改成|改为|修改为|调整为|换成|设为|写成';
const operation='删掉|删除|去掉|补上|增加|新增|补充|加上|加一句|补一句';
const mutation=new RegExp(replace+'|'+operation);
const prefix='(?:(?:请你?|麻烦你?|帮我|我建议|建议)\\s*)?';
const assign=new RegExp('^'+prefix+'(?:把|将)(.+?)(?:'+replace+')\\s*(.+)$');
const direct=new RegExp('^'+prefix+'('+replace+'|'+operation+')\\s*(.+)$');
// Quoted replacement text may contain commas and sentence punctuation.
function commandClauses(text){
 const pairs={'“':'”','「':'」','‘':'’','"':'"'},stack=[],parts=[];let part='';
 for(const ch of text){if(stack.length&&ch===stack.at(-1)){stack.pop();part+=ch;continue;}if(pairs[ch]){stack.push(pairs[ch]);part+=ch;continue;}if(!stack.length&&/[，,。；;！!\n]/.test(ch)){parts.push(part);part='';}else part+=ch;}
 if(stack.length)return [];parts.push(part);return parts;
}
// Only an actual imperative grants automatic editing. Quoted/rejected/conditional edits remain discussion.
export function ownerEditCommands(text){
 text=String(text||'').trim();if(/举例|比如|例如|假设|如果|转述|引用|供参考|仅供讨论|只是讨论|不是.{0,6}(?:指令|要求)|尚未决定|还没决定|还在考虑/.test(text))return [];if(!text||/[?？]|是否|要不要|能不能|可不可以|(?:吗|呢|么)[。！!\s]*$/.test(text))return [];
 const commands=[];
 for(let clause of commandClauses(text).map(x=>x.trim()).filter(Boolean)){
  clause=clause.replace(/^(?:@Nexus|Nexus)[\s，,:：]*/,'');if(!clause)continue;
  const a=clause.match(assign),d=clause.match(direct);
  if(a){if(/不同意|反对|不认可|原话|这句话|这段话|引用|转述|(?:把|将)/.test(a[1]))return [];commands.push({target:a[1],value:a[2],kind:'replace'});continue;}
  if(d){const kind=new RegExp('^('+replace+')$').test(d[1])?'replace':/^(删掉|删除|去掉)$/.test(d[1])?'delete':'add';commands.push({target:kind==='replace'?'':d[2],value:d[2],kind});continue;}
  // A mutation mentioned without an imperative is not authorization, even if it contains an edit verb.
  if(mutation.test(clause)||disagrees(clause)||/假设|如果|比如|例如|举例|仅转述|引用|还在考虑|尚未决定|还没决定|暂不|先别|不是让|不是要|不是指令|先讨论|仅供讨论|供参考/.test(clause))return [];
 }
 return commands;
}
const rowKey=row=>row?.ref||row?.id;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function leafPaths(before,after,path){
 if(same(before,after))return [];
 if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after))return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key=>leafPaths(before[key],after[key],path+'/'+key));
 return [path];
}
// Finer than proposal conflict paths: an evidence edit does not authorize status, owner, or gap on that same row.
export function automaticChangePaths(before,patch){return Object.entries(patch).flatMap(([field,after])=>{
 const rows=before?.[field];if(!['facts','nextInputs'].includes(field)||!Array.isArray(rows)||!Array.isArray(after))return [field];
 if([rows,after].some(list=>list.some(row=>!rowKey(row))||new Set(list.map(rowKey)).size!==list.length)||rows.length!==after.length||rows.some((row,i)=>rowKey(row)!==rowKey(after[i])))return [field];
 return after.flatMap((row,i)=>leafPaths(rows[i],row,field+'/'+rowKey(row)));
});}
const scalarFields={verdict:'结果判定|^(?:判定|结果)$',verdictReason:'判定理由',title:'标题|名称',result:'成果|结果',checks:'验收|标准|经济性',time:'日期|时间',tier:'档位',owner:'负责人',dependencies:'依赖',path:'路径',boundary:'边界',milestones:'里程碑'};
const rowFields={facts:{item:'事项|名称|标题',owner:'负责人',status:'状态|判定|结果',evidence:'事实证据|证据',gap:'没做到的原因|原因|差距'},nextInputs:{type:'类型|分类',text:'下期输入|内容|行动', 'ask/to':'提问对象|问谁', 'ask/question':'提问|问题'}};
export function requestedEditPaths(event,content,commands=ownerEditCommands(event.text)){
 const target=commands.map(c=>c.target).join('、'),block=event.context?.block||event.block,index=event.context?.item??event.item,paths=[];
 const named=Object.values(scalarFields).some(pattern=>new RegExp(pattern).test(target))||Object.values(rowFields).some(parts=>Object.values(parts).some(pattern=>new RegExp(pattern).test(target)));
 for(const [field,pattern]of Object.entries(scalarFields))if(new RegExp(pattern).test(target)||!named&&block===field)paths.push(field);
 for(const [field,parts]of Object.entries(rowFields)){
  const list=content[field]||[];
  // A row anchor selects only that row. A card/field anchor still needs explicit row names or an explicit "all".
  const rows=Number.isInteger(index)&&block===field?[list[index]]:list.filter(row=>/全部|所有|每条|每一/.test(target)||row.item&&target.includes(row.item));
  for(const [part,pattern]of Object.entries(parts))if(new RegExp(pattern).test(target))for(const row of rows)if(rowKey(row))paths.push(field+'/'+rowKey(row)+'/'+part);
 }
 return paths;
}
export const allChangesRequested=(changes,requested)=>changes.every(path=>requested.some(allowed=>path===allowed||path.startsWith(allowed+'/')));

const normalized=value=>String(value??'').replace(/\*\*|\s+/g,'').replace(/^[“「‘"']|[”」’"']$/g,'');
function atPath(content,path){return path.split('/').reduce((value,key)=>Array.isArray(value)?value.find(row=>rowKey(row)===key):value?.[key],content);}
export function automaticValuesRequested(event,anchor,before,patch,paths=automaticChangePaths(before,patch)){
 const commands=ownerEditCommands(event.text);
 return paths.every(path=>commands.some(command=>{
  if(!allChangesRequested([path],requestedEditPaths(event,anchor,[command])))return false;
  const old=atPath(before,path),value=atPath(patch,path);
  if(command.kind==='replace')return normalized(Array.isArray(value)?value.join(''):value)===normalized(command.value);
  if(command.kind==='delete'){
   if(Array.isArray(old)&&Array.isArray(value)){const kept=old.filter(item=>value.some(v=>same(item,v))),removed=old.filter(item=>!value.some(v=>same(item,v)));return removed.length>0&&same(kept,value)&&removed.every(item=>Number.isInteger(event.item)?same(old[event.item],item):normalized(item).includes(normalized(command.target)));}
   return typeof old==='string'&&typeof value==='string'&&value.length<old.length&&old.includes(value)&&normalized(old).includes(normalized(command.target));
  }
  return typeof old==='string'&&typeof value==='string'&&value.startsWith(old)&&normalized(event.text).includes(normalized(value.slice(old.length)));
 }));
}
