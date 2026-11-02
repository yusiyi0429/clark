// 上线一轮复盘 (陈溪南 2026-10-22): the review is generated off the server, so a run's result is copied into the private
// seed folder and installed from inside the container. The whole earlier collaboration state is saved first
// (kept for evaluation), then the review opens on clean rooms: earlier talk is archived and the old handoff is cleared.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {join,basename,dirname} from 'node:path';
import {installReviewRound} from './review-round.mjs';
import {archivesPath} from './collaboration-store.mjs';
import {verifyExternalReviewInstall} from './external-review-install.mjs';
import {randomUUID} from 'node:crypto';
export async function importReviewRound(store,{file,label,period,cutoff,receipt},{seedDir,statePath,busy=false,now=new Date().toISOString(),installationHead}={}){
 if(typeof file!=='string'||!/^[\w.-]+\.json$/.test(file))throw Object.assign(Error('复盘文件名只能是私有目录下的 .json 文件名'),{status:400});
 if(!/^\d{4}-\d{2}$/.test(String(period||'')))throw Object.assign(Error('需要复盘月份，例如 2026-10'),{status:400});
 if(busy)throw Object.assign(Error('有任务正在生成，等它结束再导入'),{status:409});
 const fileBytes=await readFile(join(seedDir,file)),result=JSON.parse(fileBytes);
 const reviews=Array.isArray(result.reviews)?result.reviews:Object.values(result.reviews||{});
 if(!reviews.length)throw Object.assign(Error('文件里没有复盘'),{status:400});
 const format=String(result.skill?.version||result.skillFormat||'').split('.').map(Number),formal=!!result.quality||!!result.modelProvenance||format[0]>2||format[0]===2&&(format[1]>1||format[1]===1&&format[2]>=13);
 if(formal&&!receipt)throw Object.assign(Error('正式外部生成需要真实任务审计回执，不能沿用旧失败任务'),{status:400});
 const external=receipt?await verifyExternalReviewInstall({result,fileBytes,receipt,seedDir,statePath,period,cutoff,installationHead,now}):null;
 const stamp=now.replace(/[:.]/g,'-')+'-'+randomUUID(),dir=join(dirname(statePath),'archive');
 await mkdir(dir,{recursive:true,mode:0o700});
 const saved=join(dir,`collaboration-before-review-${stamp}.json`);
 let alreadyInstalled=false;
 const next=await store.transact(async s=>{
  if(s.reviewJob?.status==='running'||s.roundJob?.status==='running'||s.planHandoff?.status==='generating')throw Object.assign(Error('有任务正在生成，等它结束再导入'),{status:409});
  if(external&&s.reviewJob?.id===external.job.id){if(s.reviewRound?.externalGeneration?.fileSha256!==external.audit.fileSha256||s.reviewJob.status!=='done')throw Object.assign(Error('同名任务已经存在且与本次导入不一致'),{status:409});alreadyInstalled=true;return s;}
  if(external&&(s.reviewJobArchives||[]).some(j=>j.job?.id===external.job.id))throw Object.assign(Error('历史任务不能重新覆盖当前轮次'),{status:409});
  // Validate before creating a backup; the queued store lock includes all human
  // edits committed before this import, and no local collaboration state is loaded.
  const installed=installReviewRound(s,{...result,period,cutoff:cutoff||result.cutoff||null},{label:label||`${Number(period.slice(5))} 月复盘`,source:basename(file),now});
  await writeFile(saved,JSON.stringify(s),{mode:0o600,flag:'wx'});
  await copyFile(archivesPath(statePath),join(dir,`collaboration-before-review-${stamp}.archives.json`)).catch(e=>{if(e.code!=='ENOENT')throw e;});
  // A fresh month-end round: no handoff, done-marks or earlier attempts carried over from testing.
  delete installed.planHandoff;delete installed.unitsDone;installed.roundAttempts=[];installed.cascadeQueue=[];
  if(external){if(s.reviewJob)(installed.reviewJobArchives??=[]).push({job:structuredClone(s.reviewJob),archivedAt:now,reason:'外部正式新轮已装入'});installed.reviewJob={...external.job,externalGeneration:external.audit,installedAt:now,updatedAt:now};installed.reviewRound.externalGeneration={...external.audit,archiveFile:basename(saved),installedAt:now};}
  return installed;
 });
 return {saved:alreadyInstalled?next.reviewRound.externalGeneration.archiveFile:basename(saved),reviews:Object.values(next.cards).filter(c=>c.kind==='review').length,label:next.reviewRound.label,...(external?{jobId:external.job.id,alreadyInstalled}: {})};
}
