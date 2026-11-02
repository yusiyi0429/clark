// Verify a completed external generation. No model calls or collaboration writes.
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {referenceMapsForInput} from './review-evidence-addresses.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex'),hash=value=>sha(JSON.stringify(value));
const uuid=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value||'');
const hex=value=>/^[a-f0-9]{64}$/.test(value||'');
const fail=message=>{throw Object.assign(Error(message),{status:400});};
export const privateReviewFilename=value=>typeof value==='string'&&/^[\w.-]+\.json$/.test(value);
const sameTime=(a,b)=>Number.isFinite(Date.parse(a))&&Date.parse(a)===Date.parse(b);
async function regular(path){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())fail('外部任务工件必须是普通文件');return readFile(path);}
export async function verifyExternalReviewInstall({result,fileBytes,receipt,seedDir,statePath,period,cutoff,installationHead,now}){
 if(!privateReviewFilename(receipt))fail('外部任务回执只能是私有目录下的 JSON 文件名');
 const receiptBytes=await regular(join(seedDir,receipt)),r=JSON.parse(receiptBytes),job=r.job;
 if(r.schemaVersion!==1||!uuid(job?.id)||job.status!=='done'||!hex(r.fileSha256)||!hex(r.workSha256)||!hex(r.inputHash)||!hex(r.sourceHash))fail('外部任务回执合同不完整');
 if(!/^[a-f0-9]{40}$/.test(r.generationHead||'')||!/^[a-f0-9]{40}$/.test(r.installationHead||''))fail('外部任务需要准确生成头和安装头');
 const built=installationHead||(JSON.parse(await readFile(new URL('./dist/build-info.json',import.meta.url),'utf8'))).commit;
 if(r.installationHead!==built)fail('回执安装头与当前服务构建不一致');
 if(sha(fileBytes)!==r.fileSha256)fail('正式复盘文件哈希与回执不一致');
 if(job.period!==period||result.period!==period||!sameTime(job.cutoff,result.cutoff)||cutoff&&!sameTime(cutoff,result.cutoff))fail('外部任务与导入复盘的月份或截止不一致');
 if(!sameTime(r.startedAt,result.startedAt)||!Number.isFinite(Date.parse(job.createdAt))||!Number.isFinite(Date.parse(job.finishedAt))||Date.parse(r.startedAt)>Date.parse(job.createdAt)||Date.parse(job.createdAt)>Date.parse(job.finishedAt)||Date.parse(job.finishedAt)>Date.parse(now))fail('外部任务真实起止时间不一致');
 const jobDir=join(dirname(statePath),'review-jobs'),workBytes=await regular(join(jobDir,job.id+'.json'));
 if(sha(workBytes)!==r.workSha256)fail('外部任务工作文件哈希不一致');
 const work=JSON.parse(workBytes),q=work.run?.quality,input=work.input;
 if(!input||work.inputHash!==hash(input)||r.inputHash!==work.inputHash||q?.inputHash!==work.inputHash||input.period!==period||!sameTime(input.cutoff,result.cutoff))fail('外部任务冻结输入与回执不一致');
 if(!r.skill?.hash||r.skill.hash!==work.skillSnapshot?.hash||r.skill.hash!==result.skill?.hash||r.skill.hash!==q?.skillHash||r.skill.version!==work.skillSnapshot?.version||r.skill.version!==result.skill?.version)fail('外部任务技能审计不一致');
 const last=q?.passes?.at(-1);
 if(q?.status!=='passed'||result.quality?.status!=='passed'||q.remaining?.length||result.quality.remaining?.length||q.verificationPending?.length||result.quality.verificationPending?.length||q.sourceHash!==r.sourceHash||result.quality.sourceHash!==r.sourceHash||result.quality.skillHash!==r.skill.hash||q.candidateHash!==hash(work.run.reviews)||last?.status!=='done'||last.reviewHash!==hash(last.reviews)||last.reviewHash!==q.candidateHash)fail('外部任务没有通过对应候选的最终质量检查');
 const quality={status:q.status,maxRevisions:q.maxRevisions,counts:q.counts,remaining:q.remaining||[],verificationPending:q.verificationPending||[],sourceHash:q.sourceHash,skillHash:q.skillHash};
 if(hash(result.quality)!==hash(quality))fail('正式文件质量审计与工作文件不一致');
 const byId=new Map(input.stages.flat().map(c=>[c.id,c]));
 const expected=Object.fromEntries(Object.entries(work.run.reviews).map(([id,review])=>{const c=byId.get(id);return [id,{...review,...(c?.agreedOutcome?{agreedOutcome:c.agreedOutcome}:{}),...(c?.sourceBasis?{sourceBasis:c.sourceBasis}:{}),...(c?.childCommitments?{childCommitments:c.childCommitments}:{}),...(c?.objectId?{objectId:c.objectId}:{}),...(c?.ownerAssigned===false?{ownerAssigned:false}:{})}];}));
 if(Object.keys(expected).length!==byId.size||hash(result.reviews)!==hash(expected))fail('正式文件正文与外部任务真实候选不一致');
 const referenceMaps=referenceMapsForInput(input,work.run.reviews);
 if(referenceMaps===undefined?result.evidenceReferences!==undefined:result.evidenceReferences===undefined||hash(result.evidenceReferences)!==hash(referenceMaps))fail('正式文件引用核验元信息与冻结来源不一致');
 const provenance={requestedPrimary:work.run.modelPolicy?.primary,initial:Object.fromEntries(input.stages.flat().filter(c=>work.run.raw?.[c.id]).map(c=>[c.id,work.run.initialCache?.[c.id]?{requestedAlias:work.run.initialCache[c.id].selectedAlias||null,returnedModel:work.run.initialCache[c.id].returnedModel??null,attemptId:work.run.initialCache[c.id].attemptId}:{requestedAlias:null,returnedModel:null,origin:'legacy-cache-unknown-model'}])),quality:Object.values(q.requests||{}).filter(r=>r.status==='done').map(r=>({ref:r.ref,pass:r.pass,stage:r.stage,maxTokens:r.callOptions?.maxTokens||r.attempts?.at(-1)?.options?.maxTokens||32000,selectedAlias:r.selectedAlias??r.model,returnedModel:r.returnedModel??null,api:r.actualApi??null}))};
 if(!provenance.requestedPrimary||result.model!==provenance.requestedPrimary||hash(result.modelProvenance)!==hash(provenance))fail('正式文件模型来源与外部任务实际记录不一致');
 const attemptsDir=join(jobDir,job.id+'.attempts'),directory=await lstat(attemptsDir);
 if(!directory.isDirectory()||directory.isSymbolicLink())fail('外部任务日志目录不合法');
 const names=(await readdir(attemptsDir)).sort(),manifest=r.journalHashes;
 if(!manifest||hash(names)!==hash(Object.keys(manifest).sort())||!names.length)fail('外部任务日志清单不完整');
 const attempts=new Map((work.run.initialAttempts||[]).map(a=>[a.id,a]));
 if(names.length!==attempts.size)fail('外部任务日志与初稿尝试数量不一致');
 for(const name of names){const id=name.replace(/\.json$/,'');if(!uuid(id)||name!==id+'.json'||!hex(manifest[name]))fail('外部任务日志文件名或哈希不合法');const bytes=await regular(join(attemptsDir,name));if(sha(bytes)!==manifest[name])fail('外部任务日志哈希不一致');const {schemaVersion,...record}=JSON.parse(bytes);if(schemaVersion!==1||hash(record)!==hash(attempts.get(id)))fail('外部任务日志与工作文件原记录不一致');}
 return {job:{id:job.id,status:'done',period:job.period,cutoff:job.cutoff,createdAt:job.createdAt,startedAt:r.startedAt,finishedAt:job.finishedAt,done:byId.size,total:byId.size,stage:'已装入',error:null,errorCode:null,checks:[],candidateAvailable:false,skill:r.skill,modelPolicy:work.run.modelPolicy,warnings:result.qualityWarnings||[],skipped:result.skipped||[]},audit:{jobId:job.id,generationHead:r.generationHead,installationHead:built,receiptFile:receipt,receiptSha256:sha(receiptBytes),fileSha256:r.fileSha256,workSha256:r.workSha256,journalManifestHash:hash(manifest),inputHash:r.inputHash,sourceHash:r.sourceHash,skill:r.skill,qualityStatus:q.status,modelPolicy:work.run.modelPolicy,outputPolicy:work.run.outputPolicy,startedAt:r.startedAt,finishedAt:job.finishedAt}};
}
