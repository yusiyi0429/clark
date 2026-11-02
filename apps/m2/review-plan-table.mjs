// Preserve source columns; a weekly schedule is never an acceptance standard.
export function markdownCells(line){
 const cells=[];let cell='',ticks=0,lastDelimiter=false;
 for(let i=0;i<line.length;i++){
  const c=line[i];
  if(c==='\\'&&line[i+1]==='|'){cell+='\\|';lastDelimiter=false;i++;continue;}
  if(c==='`'){let n=1;while(line[i+n]==='`')n++;ticks=ticks===n?0:ticks||n;cell+=line.slice(i,i+n);i+=n-1;continue;}
  if(c==='|'&&!ticks){cells.push(cell.trim());cell='';lastDelimiter=true;}else{cell+=c;if(c.trim())lastDelimiter=false;}
 }
 cells.push(cell.trim());if(line.trimStart().startsWith('|'))cells.shift();if(lastDelimiter)cells.pop();return cells;
}
export function sourceMarkdownTables(documents){
 const tables=new Map();
 for(const document of new Set(documents.filter(x=>typeof x==='string'&&x.trim()))){const lines=document.split(/\r?\n/);
  for(let i=0;i<lines.length-1;i++){
   if(!lines[i].includes('|'))continue;
   const headers=markdownCells(lines[i]),separator=markdownCells(lines[i+1]);
   if(headers.length<2||separator.length!==headers.length||separator.some(c=>!/^:?-+:?$/.test(c)))continue;
   let end=i+2;while(end<lines.length&&lines[end].includes('|')&&lines[end].trim())end++;
   const text=lines.slice(i,end).join('\n'),rows=lines.slice(i+2,end).map(raw=>({raw,cells:markdownCells(raw)}));
   tables.set(text,{text,headers,rows});i=end-1;
  }
 }
 return [...tables.values()];
}
export function planTableItem(rawRow,documents){
 const title=String(rawRow||'').trim();if(!title.includes('|'))return {title};
 const tables=sourceMarkdownTables(documents),matches=tables.flatMap(table=>table.rows.filter(row=>row.raw.trim()===title).map(row=>({table,row})));
 const distinct=[...new Map(matches.map(m=>[JSON.stringify([m.table.headers,m.row.cells]),m])).values()];
 if(distinct.length!==1)return {title,planTable:{status:distinct.length?'ambiguous':'unmatched',rawRow:title,cells:markdownCells(title),sourceTables:tables}};
 const {table,row}=distinct[0],taskColumns=table.headers.map((h,index)=>/^(Task|任务|任务名称)$/i.test(h.trim())?index:-1).filter(i=>i>=0);
 if(row.cells.length!==table.headers.length||taskColumns.length!==1)return {title,planTable:{status:'ambiguous',rawRow:title,sourceTables:[table]}};
 return {title:row.cells[taskColumns[0]],planTable:{status:'matched',rawRow:title,text:table.text,headers:table.headers,cells:row.cells,columns:table.headers.map((header,i)=>({header,value:row.cells[i]}))}};
}
