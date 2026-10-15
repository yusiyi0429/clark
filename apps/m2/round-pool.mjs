// Keep slots busy, but stop dequeuing on failure and drain in-flight work before return.
export async function runRoundPool(items,worker,concurrency=2){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>50)throw Error('拆解并发数必须是1到50的整数');
 let next=0,failure;
 const run=async()=>{
  while(!failure&&next<items.length){
   const item=items[next++];
   try{await worker(item);}catch(error){failure??=error;}
  }
 };
 await Promise.all(Array.from({length:Math.min(concurrency,items.length)},run));
 if(failure)throw failure;
}
