import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export const seedRoot=()=>resolve(process.env.M2_SEED_DIR||'seed/m2');
export async function loadBootstrap(){
 const value=JSON.parse(await readFile(join(seedRoot(),'bootstrap.json'),'utf8'));
 if(value.schemaVersion!==1||!value.state?.round?.units?.length||!value.state.cards||!value.state.round.input)throw Error('M2 缺少有效试用数据，未使用演示数据代替');
 return value;
}
export async function loadPublishedRound08(){return loadPublished(8);}
export async function loadPublishedRound09(){return loadPublished(9);}
export async function loadOntologyCandidate(){return loadPublished(10);}
async function loadPublished(number){
 const value=JSON.parse(await readFile(join(seedRoot(),`round-${number}.json`),'utf8'));
 if(value.number!==number||!value.units?.length||!value.input)throw Error('历史轮次与导入记录不一致');
 return value;
}
export function skillLocation(){return pathToFileURL(resolve(process.env.DECODING_SKILL_DIR||new URL('./skill/',import.meta.url).pathname)+'/');}
