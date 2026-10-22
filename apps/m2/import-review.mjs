// Run inside the m2 container: node import-review.mjs <file in M2_SEED_DIR> --period 2026-10 [--cutoff ISO] [--label 名称]
// Calls the running server over loopback with the internal token, so the single writer applies it.
const args=process.argv.slice(2),file=args[0],opt=k=>{const i=args.indexOf('--'+k);return i>0?args[i+1]:undefined;};
if(!file||!opt('period')){console.error('用法：node import-review.mjs <私有目录里的文件名> --period 2026-10 [--cutoff 2026-10-22T23:59:59+08:00] [--label 名称]');process.exit(2);}
const r=await fetch(`http://127.0.0.1:${process.env.PORT||4333}/api/review-import`,{method:'POST',headers:{'Content-Type':'application/json','x-m2-internal-token':process.env.M2_INTERNAL_TOKEN||''},body:JSON.stringify({file,period:opt('period'),cutoff:opt('cutoff'),label:opt('label')})});
const v=await r.json().catch(()=>({}));console.log(r.status,JSON.stringify(v));process.exit(r.ok?0:1);
