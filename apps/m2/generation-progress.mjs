// Estimate within the observed stage. Never present elapsed time as real completion.
export function generationProgress(job,now=Date.now(),stageStarted=now){
 const created=Date.parse(job.createdAt),elapsed=Number.isFinite(created)?Math.max(0,Math.floor((now-created)/1000)):0;
 const stage=job.stage||'',ratio=job.total>0?Math.min(1,Math.max(0,(job.done||0)/job.total)):0;
 let start=1,end=9;
 if(/全局 PO/.test(stage)){start=10;end=24;}
 else if(/细化|续跑/.test(stage)){start=25+ratio*55;end=Math.min(84,start+4);}
 else if(/跨领域|资源缺口/.test(stage)){start=85;end=89;}
 else if(/修正/.test(stage)){start=90+ratio*5;end=Math.min(97,start+2);}
 else if(/复核/.test(stage)){start=97;end=99;}
 else if(/整理简洁/.test(stage)){start=98;end=99;}
 const percent=Math.min(99,Math.floor(start+(end-start)*(1-Math.exp(-Math.max(0,now-stageStarted)/120000))));
 return {percent,elapsed,wait:`${Math.floor(elapsed/60)}分${String(elapsed%60).padStart(2,'0')}秒`};
}
