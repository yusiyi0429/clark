import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {applyAction} from './governance.mjs';
// Single writer, explicitly locked. Never run multiple processes against this path.
// Reads share one deep-frozen copy per state version: the state is ~50MB, and cloning it on every read
// (several times per request, every 1.5s per open page) saturated the CPU and stalled writes.
const deepFreeze=o=>{if(o&&typeof o==='object'&&!Object.isFrozen(o)){Object.freeze(o);for(const v of Object.values(o))deepFreeze(v);}return o;};
// Earlier rounds (state.archives) live in a sidecar file: they were ~38MB of a 40MB state and made every save
// (confirm, comment, accept) rewrite them, so each button took about a second (陈溪南 2026-10-21).
export const archivesPath=path=>path.replace(/\.json$/,'')+'.archives.json';
export async function openCollaborationStore(path,initial){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const lock=await open(path+'.lock','wx',0o600);
 let state,queue=Promise.resolve(),closing,view=null;
 try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT'){await lock.close();await unlink(path+'.lock');throw e;}state=structuredClone(initial);}
 const atomic=async(file,value)=>{const temp=join(dirname(file),`.state-${randomUUID()}.tmp`);await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,file);};
 async function moveArchives(next){if(!next.archives?.length){delete next.archives;return;}let kept=[];try{kept=JSON.parse(await readFile(archivesPath(path),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}await atomic(archivesPath(path),[...kept,...next.archives]);delete next.archives;}
 async function persist(next){await moveArchives(next);await atomic(path,next);}
 if(state.archives?.length)await persist(state);
 return {
  snapshot:()=>view??=deepFreeze(structuredClone(state)),
  transact(mutator){const task=queue.then(async()=>{const next=await mutator(structuredClone(state));await persist(next);state=next;view=null;return structuredClone(next);});queue=task.catch(()=>{});return task;},
  apply(actor,action){const task=queue.then(async()=>{const next=applyAction(state,actor,action);await persist(next);state=next;view=null;return structuredClone(next);});queue=task.catch(()=>{});return task;},
  close(){return closing??=(async()=>{await queue;await lock.close();await unlink(path+'.lock');})();}
 };
}
