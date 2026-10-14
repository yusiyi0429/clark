import {readFile} from 'node:fs/promises';
export async function roundMetadata(round,fallbackInput){
 const input=round?.input||fallbackInput||{};
 let generationModel=input.model||null;
 let generationTiming=input.generationTiming||null;
 const readerViews=round?.readerViews||input.readerViews;
 // This legacy round has no audit-end timestamp. The final detail log gives only a lower bound.
 if(!generationTiming&&round?.id==='0df7de8e-e89b-49d1-9016-53282b894421'){
  try{const run=JSON.parse(await readFile(new URL('./.runtime/model-runs/8e7d79e6-9a82-4b8a-b3ab-efe3ed3a5d07.json',import.meta.url),'utf8'));if(run.createdAt==='2026-10-13T10:12:22.232Z'&&run.scope==='talent')generationTiming={durationMs:Date.parse(run.createdAt)-Date.parse('2026-10-13T09:30:10.308Z'),lowerBound:true};}catch{}
 }
 // Historical provenance comes from the generation audit, not today's gateway.
 const published={8:'m2-round08-v154-20261012',9:'m2-round09-v156-20261012'};
 if(!generationModel&&published[round?.number]&&round.id?.startsWith(`published-round0${round.number}-`)){
  try{generationModel=JSON.parse(await readFile(new URL(`../../output/${published[round.number]}/generation-audit.json`,import.meta.url),'utf8')).model||null;}catch{}
 }
 return {sourceMode:input.mode||null,sourceTitles:[...new Set((input.sources||[]).map(s=>s.title).filter(Boolean))],generationModel:generationModel?{model:generationModel.model||generationModel.id||null,reasoningEffort:generationModel.reasoningEffort||null}:null,...(generationTiming?{generationTiming}:{}),...(round?.audit?{roundAudit:round.audit}:{}),...(readerViews?{readerViews}:{})};
}
