// Estimate within the observed stage. Never present elapsed time as real completion.
export function generationProgress(job,now=Date.now(),stageStarted=now){
 const created=Date.parse(job.createdAt),elapsed=Number.isFinite(created)?Math.max(0,Math.floor((now-created)/1000)):0;
 const stage=job.stage||'',ratio=job.total>0?Math.min(1,Math.max(0,(job.done||0)/job.total)):0;
 let start=1,end=9;
 // Layered rounds: each layer takes a band; generation, checks and revisions move within it.
 const layer=[['PO 层',10,30],['Mission 层',30,56],['Task 层',56,82],['总校验',82,94],['精简',94,99]].find(([name])=>stage.startsWith(name));
 // Round runner v3 stages (战场 → 能力域 → 检查与修改 → 拆 Task → 全局对齐 → 总校验 → 精简).
 const v3=[['战场',8,28],['能力域',28,48],['领域计划',48,60],['检查与修改',48,60],['拆 Task',60,80],['全局对齐',80,90]].find(([name])=>stage.startsWith(name));
 if(!layer&&v3){const [,from,to]=v3,span=to-from;start=from+span*ratio*0.8;end=Math.min(to,start+span*0.2);}
 else if(layer){const [,from,to]=layer,span=to-from,step=/并行生成/.test(stage)?ratio*0.5:/交叉验证/.test(stage)?0.5+ratio*0.25:/修改|精简/.test(stage)?0.75+ratio*0.2:0.95;start=from+span*step;end=Math.min(to,start+span*0.15);}
 else if(/全局 PO/.test(stage)){start=10;end=24;}
 else if(/细化|续跑/.test(stage)){start=25+ratio*55;end=Math.min(84,start+4);}
 else if(/跨领域|资源缺口/.test(stage)){start=85;end=89;}
 else if(/修正/.test(stage)){start=90+ratio*5;end=Math.min(97,start+2);}
 else if(/复核/.test(stage)){start=97;end=99;}
 else if(/整理简洁/.test(stage)){start=98;end=99;}
 const percent=Math.min(99,Math.floor(start+(end-start)*(1-Math.exp(-Math.max(0,now-stageStarted)/120000))));
 return {percent,elapsed,wait:`${Math.floor(elapsed/60)}分${String(elapsed%60).padStart(2,'0')}秒`};
}
