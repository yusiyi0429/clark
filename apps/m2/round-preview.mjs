import {validateRound} from './round-runner.mjs';
import {finishGeneratedRound} from './round-completion.mjs';
import {allNodes} from './domain.mjs';
export function previewFailedRound(state,jobId,model){
 const job=state.roundJob;
 if(job?.id!==jobId||job.status!=='failed'||job.stage!=='检查跨领域组合与资源缺口'||!job.input||!job.skillSnapshot)throw Object.assign(Error('没有可展示的完整细化草稿'),{status:409});
 const raw=structuredClone(job.partialUnits||[]),units=validateRound(raw);
 const result={raw,units,input:structuredClone(job.input),counts:{po:units.length,mission:allNodes(units).filter(n=>n.level==='mission').length,task:allNodes(units).filter(n=>n.level==='task').length},audit:{status:'incomplete',summary:'跨领域审核未完成；当前展示本轮已生成候选，未确认。',gaps:[job.error],failure:job.errorDiagnostics||null}};
 const next=finishGeneratedRound(state,jobId,result,job.skillSnapshot,model,true);
 // Older failures did not record their end. Import time is not generation time.
 if(!job.finishedAt){delete next.round.input.generationTiming;delete next.roundJob.result.input.generationTiming;delete next.roundJob.finishedAt;}
 next.roundJob.stage='本轮候选已显示，跨领域审核未完成';
 return next;
}
