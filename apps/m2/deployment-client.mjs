export async function m2Fetch(input,options){
 const url=typeof input==='string'&&input.startsWith('/api/')?'/m2'+input:input;
 const response=await globalThis.fetch(url,options);
 if(response.status===401){window.location.assign('/access');throw Error('登录已失效，请重新登录天枢');}
 if(response.status===403){let value;try{value=await response.clone().json();}catch{}throw Error(value?.error||'当前账号没有此项权限');}
 return response;
}
