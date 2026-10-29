// Presentation-only codec. Source identity lives in hidden comments; business text stays ordinary Markdown.
const names={item:'事项',owner:'负责人',status:'状态',evidence:'证据',gap:'没做到的原因',type:'类型',text:'内容',ask:'追问','ask.to':'提问对象','ask.question':'提问',choice:'建议',reason:'理由',from:'来源',to:'交付给',result:'成果',time:'时间'};
const factColumns=['item','owner','status','evidence','gap'];
const specialColumns={facts:factColumns,nextInputs:['type','text','ask.to','ask.question'],causes:['text','ask'],ltoReview:['choice','reason']};
const fail=message=>{throw Object.assign(Error(message),{status:400});};
const isObject=v=>v&&typeof v==='object'&&!Array.isArray(v);
const clone=v=>structuredClone(v);
const get=(value,path)=>path.split('.').reduce((v,k)=>v?.[k],value);
const has=(value,path)=>{const parts=path.split('.');return parts.slice(0,-1).every((_,i)=>isObject(get(value,parts.slice(0,i+1).join('.'))))&&Object.prototype.hasOwnProperty.call(parts.length===1?value:get(value,parts.slice(0,-1).join('.')),parts.at(-1));};
function set(value,path,next){const parts=path.split('.');let o=value;for(const p of parts.slice(0,-1)){if(['__proto__','prototype','constructor'].includes(p))fail('模板标记不合法');o=o[p]??={};}o[parts.at(-1)]=next;}
const protect=text=>String(text).replace(/&/g,'&amp;').replace(/<!--\s*(?:m2-|\/m2-)/g,m=>'&lt;'+m.slice(1));
const unprotect=text=>text.replace(/&lt;!--\s*(m2-|\/m2-)/g,(_,p)=>'<!-- '+p).replace(/&amp;/g,'&');
const cell=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\/g,'\\\\').replace(/\|/g,'\\|').replace(/\r/g,'&#13;').replace(/\t/g,'&#9;').replace(/\n/g,'<br>').replace(/^ +| +$/g,m=>'&#32;'.repeat(m.length));
function cells(line){let out=[],part='',escaped=false;for(const ch of line.trim().replace(/^\|/,'').replace(/\|$/,'') ){if(escaped){part+='\\'+ch;escaped=false;}else if(ch==='\\')escaped=true;else if(ch==='|'){out.push(part.trim());part='';}else part+=ch;}if(escaped)part+='\\';out.push(part.trim());return out;}
const uncell=value=>value.replace(/\\([\\|])/g,'$1').replace(/<br\s*\/?>/gi,'\n').replace(/&#32;/g,' ').replace(/&#9;/g,'\t').replace(/&#13;/g,'\r').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function descriptor(key,value){
 if(typeof value==='string')return {key,format:'text'};
 if(Array.isArray(value)&&value.every(v=>typeof v==='string'))return {key,format:'list'};
 const records=Array.isArray(value)?value:isObject(value)?[value]:null;
 if(!records||records.some(v=>!isObject(v)))fail('这个字段暂不支持模板导出');
 const wanted=specialColumns[key]||[...new Set(records.flatMap(v=>Object.keys(v).filter(k=>!['id','ref'].includes(k)&&typeof v[k]==='string')))];
 const columns=wanted.filter(k=>records.some(v=>has(v,k))||specialColumns[key]?.includes(k));
 // Preserve invisible context and exact original key order; editable text is always read from the table.
 return {key,format:Array.isArray(value)?'records':'object',columns,rows:records.map(row=>{const original=clone(row);for(const path of columns)if(has(original,path))set(original,path,'');return {original};})};
}
function blankValue(key,value){
 if(typeof value==='string')return '';
 if(Array.isArray(value)&&value.every(v=>typeof v==='string'))return [];
 const records=Array.isArray(value)?value:[value],out=records.map(row=>{const v=clone(row);for(const path of specialColumns[key]||Object.keys(row))if(!['item','owner','type','ref','id'].includes(path)&&has(v,path))set(v,path,'');return v;});return Array.isArray(value)?out:out[0];
}
function table(meta,value,{markers=true}={}){
 const rows=Array.isArray(value)?value:[value],labels=meta.columns.map((k,i)=>names[k]||`补充内容 ${i+1}`);
 const head=`| ${labels.join(' | ')} |\n| ${labels.map(()=> '---').join(' | ')} |`;
 return head+(rows.length?'\n'+rows.map((row,i)=>`| ${meta.columns.map((path,j)=>(j===0&&markers?`<!-- m2-row:${i} -->`:'')+cell(get(row,path))).join(' | ')} |`).join('\n'):'');
}
function render(meta,value,options){if(meta.format==='text')return protect(value);if(meta.format==='list')return value.map((v,i)=>`${i+1}. ${protect(v).split('\n').join('\n   ')}`).join('\n');return table(meta,value,options);}
export function readableField(key,value,{blank=false}={}){const meta=descriptor(key,value),display=blank?blankValue(key,value):value;return {meta,body:render(meta,display,{markers:true})};}
export function readableValue(key,value){if(value==null)return '空白';const meta=descriptor(key,value);return render(meta,value,{markers:false});}
export function parseReadableField(meta,body){
 if(!meta||typeof meta.key!=='string'||!['text','list','records','object'].includes(meta.format))fail('字段标记格式错误');
 if(meta.format==='text')return unprotect(body);
 if(meta.format==='list'){
  if(!body.trim())return [];const values=[];let current=null;
  for(const line of body.split('\n')){const m=line.match(/^(?:\d+[.)]|[-+*]) (.*)$/);if(m){if(current!==null)values.push(unprotect(current));current=m[1];}else if(/^ {3}/.test(line)&&current!==null)current+='\n'+line.slice(3);else if(/^ {2}/.test(line)&&current!==null)current+='\n'+line.slice(2);else if(!line.trim())continue;else fail('列表格式不明确，请使用有序列表或项目列表');}
  if(current!==null)values.push(unprotect(current));return values;
 }
 if(!Array.isArray(meta.columns)||!Array.isArray(meta.rows)||meta.columns.some(k=>typeof k!=='string'||k.split('.').some(p=>['__proto__','constructor','prototype'].includes(p))))fail('表格标记格式错误');
 const lines=body.split('\n').filter(l=>l.trim());if(lines.length<2)fail('事实表格式不完整');
 const expected=meta.columns.map((k,i)=>names[k]||`补充内容 ${i+1}`),headers=cells(lines[0]).map(uncell);
 if(headers.length!==expected.length||new Set(headers).size!==headers.length||headers.some(h=>!expected.includes(h)))fail('表格标题无法对应标准字段');
 if(cells(lines[1]).some(v=>!/^:?-{3,}:?$/.test(v)))fail('表格分隔行不完整');
 const results=new Map();
 for(const line of lines.slice(2)){
  const values=cells(line),ids=[...line.matchAll(/<!-- m2-row:(\d+) -->/g)];if(values.length!==headers.length||ids.length!==1)fail('条目标记缺失，无法对应原条目');const index=Number(ids[0][1]);
  if(!meta.rows[index]||results.has(index))fail('条目标记重复或不在当前模板');
  const row=clone(meta.rows[index].original);if(!isObject(row))fail('条目标记格式错误');
  for(let j=0;j<headers.length;j++){const path=meta.columns[expected.indexOf(headers[j])],text=uncell(values[j].replace(/<!-- m2-row:\d+ -->/,''));if(has(row,path)||text!=='')set(row,path,text);}
  results.set(index,row);
 }
 if(results.size!==meta.rows.length)fail('条目增删无法对应，请保留原条目或使用非标准导入');
 const records=meta.rows.map((_,i)=>results.get(i));return meta.format==='object'?records[0]:records;
}
