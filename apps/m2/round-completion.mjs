import {activateIndependentRound} from './round-activation.mjs';
export function finishGeneratedRound(state,id,result,skill,model,autoActivate=false){
 if(state.roundJob?.id!==id)return state;
 const finishedAt=state.roundJob.finishedAt||new Date().toISOString();
 const startedAt=state.roundJob.createdAt;
 if(startedAt&&Number.isFinite(Date.parse(startedAt)))result.input.generationTiming={startedAt,finishedAt,durationMs:Math.max(0,Date.parse(finishedAt)-Date.parse(startedAt))};
 result.input.skill={version:skill.version,hash:skill.hash,files:skill.files,loadedAt:skill.loadedAt};
 result.input.model={...model,...result.input.model,reasoningEffort:result.input.model?.reasoningEffort||'未提供／无法核实'};
 const job={...state.roundJob,finishedAt,status:'ready',stage:'候选已生成，待审阅',counts:result.counts,result};
 if(autoActivate){
  const next=activateIndependentRound(state,{id,number:(state.round?.number||6)+1,units:result.units,input:result.input,audit:result.audit});
  next.roundJob={...job,status:'activated',stage:'新轮已显示在画布，旧轮已保留'};
  return next;
 }
 state.roundJob=job;state.sequence++;return state;
}
