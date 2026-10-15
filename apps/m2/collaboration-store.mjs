import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {applyAction} from './governance.mjs';
// Live state is a frozen private copy: read() hands it out without copying, so a reader that tries to mutate it fails loudly.
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const v of Object.values(value))freeze(v);}return value;}
// Single writer, explicitly locked. Never run multiple processes against this path.
export async function openCollaborationStore(path,initial){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const lock=await open(path+'.lock','wx',0o600);
 let state,queue=Promise.resolve(),closing;
 try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT'){await lock.close();await unlink(path+'.lock');throw e;}state=structuredClone(initial);}
 freeze(state);
 async function persist(next){const temp=join(dirname(path),`.state-${randomUUID()}.tmp`);await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,path);}
 return {
  snapshot:()=>structuredClone(state),
  // Read-only view of the current state, without the deep copy. Replaced, never mutated, on each write.
  read:()=>state,
  transact(mutator){const task=queue.then(async()=>{const next=await mutator(structuredClone(state));await persist(next);state=freeze(structuredClone(next));return next;});queue=task.catch(()=>{});return task;},
  apply(actor,action){const task=queue.then(async()=>{const next=applyAction(state,actor,action);await persist(next);state=freeze(structuredClone(next));return next;});queue=task.catch(()=>{});return task;},
  close(){return closing??=(async()=>{await queue;await lock.close();await unlink(path+'.lock');})();}
 };
}
