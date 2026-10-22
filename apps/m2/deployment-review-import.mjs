// 上线一轮复盘 (陈溪南 2026-10-22): the review is generated off the server, so a run's result is copied into the private
// seed folder and installed from inside the container. The whole earlier collaboration state is saved first
// (kept for evaluation), then the review opens on clean rooms: earlier talk is archived and the old handoff is cleared.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,basename,dirname} from 'node:path';
import {installReviewRound} from './review-round.mjs';
import {archivesPath} from './collaboration-store.mjs';
export async function importReviewRound(store,{file,label,period,cutoff},{seedDir,statePath,busy=false,now=new Date().toISOString()}){
 if(typeof file!=='string'||!/^[\w.-]+\.json$/.test(file))throw Object.assign(Error('复盘文件名只能是私有目录下的 .json 文件名'),{status:400});
 if(!/^\d{4}-\d{2}$/.test(String(period||'')))throw Object.assign(Error('需要复盘月份，例如 2026-10'),{status:400});
 if(busy)throw Object.assign(Error('有任务正在生成，等它结束再导入'),{status:409});
 const result=JSON.parse(await readFile(join(seedDir,file),'utf8'));
 const reviews=Array.isArray(result.reviews)?result.reviews:Object.values(result.reviews||{});
 if(!reviews.length)throw Object.assign(Error('文件里没有复盘'),{status:400});
 const stamp=now.replace(/[:.]/g,'-'),dir=join(dirname(statePath),'archive');
 await mkdir(dir,{recursive:true,mode:0o700});
 const saved=join(dir,`collaboration-before-review-${stamp}.json`);
 await writeFile(saved,JSON.stringify(store.snapshot()),{mode:0o600});
 await copyFile(archivesPath(statePath),join(dir,`collaboration-before-review-${stamp}.archives.json`)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 const next=await store.transact(s=>{
  if(s.roundJob?.status==='running'||s.planHandoff?.status==='generating')throw Object.assign(Error('有任务正在生成，等它结束再导入'),{status:409});
  // A fresh month-end round: no handoff, done-marks or earlier attempts carried over from testing.
  delete s.planHandoff;delete s.unitsDone;s.roundAttempts=[];s.cascadeQueue=[];
  return installReviewRound(s,{...result,period,cutoff:cutoff||result.cutoff||null},{label:label||`${Number(period.slice(5))} 月复盘`,source:basename(file),now});
 });
 return {saved:basename(saved),reviews:Object.values(next.cards).filter(c=>c.kind==='review').length,label:next.reviewRound.label};
}
