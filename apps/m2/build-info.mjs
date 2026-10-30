import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const fullCommit=value=>/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value||'')?value.toLowerCase():null;
// Never borrow the enclosing TKOS repository's revision when building an archive.
export function readM2Git(moduleRoot,git=(args)=>execFileSync('git',args,{cwd:moduleRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()){
 try{
  const top=git(['rev-parse','--show-toplevel']);if(resolve(top,'apps/m2')!==resolve(moduleRoot))return null;
  if(!git(['ls-files','--error-unmatch','build.mjs']))return null;
  const commit=fullCommit(git(['rev-parse','HEAD']));if(!commit)return null;
  return {commit,dirty:Boolean(git(['status','--porcelain','--untracked-files=no','--','.']))};
 }catch{return null;}
}
export function m2BuildInfo({moduleRoot,env=process.env,now=new Date(),git=readM2Git(moduleRoot)}={}){
 const supplied=env.M2_BUILD_COMMIT,commit=supplied?fullCommit(supplied):git?.commit||null;
 if(supplied&&!commit)throw Error('M2_BUILD_COMMIT 必须是完整 Git 提交号');
 if(supplied&&git?.commit&&git.commit!==commit)throw Error('M2_BUILD_COMMIT 与当前 M2 checkout 不一致');
 const environment=['production','preview','staging','local'].includes(env.M2_BUILD_ENV)?env.M2_BUILD_ENV:'unknown';
 return {commit,builtAt:now.toISOString(),environment,dirty:git?.dirty??null};
}
