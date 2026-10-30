const release=value=>/^\d+\.\d+\.\d+$/.test(value||'')?value:null;
const runtimeEnvironment=(info,hostname)=>/^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(hostname)?'本地':({production:'生产',preview:'预览',staging:'测试'}[info?.environment]||'未知');
export function m2VersionLabel(info={}){
 const version=release(info?.releaseVersion);
 return version?`M2 v${version.replace(/\.0$/,'')}`:'M2 版本未提供';
}
export function m2VersionDetails(info={},hostname=''){
 const date=new Date(info?.builtAt||''),builtAt=Number.isNaN(date.valueOf())?'未提供':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date)+'（北京时间）';
 return [m2VersionLabel(info),`访问环境：${runtimeEnvironment(info,hostname)}`, `提交：${info?.commit||'未提供'}`,`构建时间：${builtAt}`,`构建目标：${{production:'生产',preview:'预览',staging:'测试',local:'本地'}[info?.environment]||'未知'}`,`工作区：${info?.dirty===true?'含未提交修改':info?.dirty===false?'无已跟踪修改':'未提供'}`].join('\n');
}
