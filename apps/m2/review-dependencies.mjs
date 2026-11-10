// Run only ready nodes. A finished branch may advance while unrelated calls
// are still running. Stop scheduling after an error, but persist in-flight work.
export async function reviewDependencyPool({items,concurrency,dependencies,execute,signal}){
 if(!Number.isInteger(concurrency)||concurrency<1)throw Error('生成并发必须是正整数');
 const pending=new Map(items.map(item=>[item.id,item])),ids=new Set(pending.keys()),done=new Set(),running=new Map();
 if(ids.size!==items.length)throw Error('生成依赖包含重复对象');
 let failure;
 while(pending.size||running.size){
  if(signal?.aborted)failure??=signal.reason||Error('生成已停止');
  if(!failure)for(const [id,item] of pending){
   if(running.size>=concurrency)break;
   if(dependencies(item).some(ref=>ids.has(ref)&&!done.has(ref)))continue;
   pending.delete(id);
   const task=Promise.resolve().then(()=>execute(item)).then(()=>({id}),error=>({id,error}));
   running.set(id,task);
  }
  if(!running.size){if(failure)throw failure;if(pending.size)throw Error('生成依赖存在循环或未完成节点');break;}
  const result=await Promise.race(running.values());running.delete(result.id);
  if(result.error)failure??=result.error;else done.add(result.id);
 }
 if(failure)throw failure;
}
