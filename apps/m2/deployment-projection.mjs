import {canRead} from './governance.mjs';
export function visibleReaderViews(views,state,actor){
 return views?Object.fromEntries(Object.entries(views).filter(([id])=>state.cards[id]&&canRead(actor,state.cards[id],state))):undefined;
}
export function generationView(job,actor){
 if(!job)return null;
 const skill=job.skillSnapshot;
 return {id:job.id,status:job.status,stage:job.stage,done:job.result?10:job.done,total:job.result?10:job.total,createdAt:job.createdAt,finishedAt:job.finishedAt,counts:job.counts,
  canResume:actor.ceo&&!!job.input&&!!skill,skillSnapshot:skill?{version:skill.version,hash:skill.hash,loadedAt:skill.loadedAt}:null,
  ...(actor.ceo?{error:job.error,retry:job.retry,sourceRetry:job.sourceRetry,audit:job.result?.audit,sources:(job.result?.input?.sources||job.input?.sources||[]).map(s=>({title:s.title,revision:s.revision,hash:s.hash}))}:{error:job.status==='failed'?'本轮生成未完成，等待公司负责人处理':undefined})};
}
