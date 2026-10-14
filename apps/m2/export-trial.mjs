// Run beside the original demo. Read-only snapshot; never copy credentials or model logs.
import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const source=resolve(process.argv[2]||''),target=resolve(process.argv[3]||'');
if(!process.argv[2]||!process.argv[3]||target===source)throw Error('Usage: node export-trial.mjs <demo-workspace> <private-seed-directory>');
const text=await readFile(join(source,'apps/decoding-mvp/.runtime/collaboration.json'),'utf8');
const state=JSON.parse(text);
if(state.roundJob?.status==='running'||state.roundAuditJob?.status==='running')throw Error('任务仍在运行，不能固定试用版本');
if(!state.round?.units?.length||!state.round?.input)throw Error('缺少完整轮次');
await mkdir(target,{recursive:true,mode:0o700});
await writeFile(join(target,'bootstrap.json'),JSON.stringify({schemaVersion:1,state}),{mode:0o600});
await copyFile(join(source,'output/ontology-real-run-20261013/source-manifest.json'),join(target,'source-manifest.json'));
await writeFile(join(target,'snapshot-receipt.json'),JSON.stringify({round:state.round.number,roundId:state.round.id,sourceSha256:createHash('sha256').update(text).digest('hex'),exportedAt:new Date().toISOString(),messages:state.messages.length,archives:state.archives?.length||0},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({round:state.round.number,archives:state.archives?.length||0,exported:true,accounts:'需核对旧版 personId 到 M2 memberId 的映射'}));
