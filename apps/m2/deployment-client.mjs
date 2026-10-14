export async function m2Fetch(input,options){
 const url=typeof input==='string'&&input.startsWith('/api/')?'/m2'+input:input;
 if(options?.method==='POST'&&typeof options.body==='string'){
  const memberId=JSON.parse(options.body).memberId;
  if(memberId)options={...options,headers:{...options.headers,'X-M2-Expected-Member':memberId}};
 }
 const response=await globalThis.fetch(url,options);
 if(response.status===409){const value=await response.clone().json();if(value.code==='IDENTITY_CHANGED'){window.location.reload();throw Error(value.error);}}
 if(response.status===401){window.location.assign('/access');throw Error('登录已失效，请重新登录天枢');}
 if(response.status===403){let value;try{value=await response.clone().json();}catch{}throw Error(value?.error||'当前账号没有此项权限');}
 return response;
}
