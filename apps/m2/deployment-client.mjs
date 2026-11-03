import {capturePageFocus} from './confirmation-focus.mjs';
import {confirmInPage} from './page-confirmation.mjs';
export async function m2Fetch(input,options){
 const {confirmationFocus=capturePageFocus(),...requestOptions}=options||{};options=requestOptions;
 const url=typeof input==='string'&&input.startsWith('/api/')?'/m2'+input:input;
 if(options?.method==='POST'&&typeof options.body==='string'){
  const memberId=JSON.parse(options.body).memberId;
  if(memberId){const headers=new Headers(options.headers);headers.set('X-M2-Expected-Member',memberId);options={...options,headers};}
 }
 // Freeze the request before the first await, including the confirmation retry.
 if(options)options={...options,headers:options.headers?new Headers(options.headers):undefined};
 const response=await globalThis.fetch(url,options);
 if(response.status===409){const value=await response.clone().json();if(value.code==='RECONFIRM_REQUIRED'&&value.reconfirmToken&&options?.method==='POST'&&typeof options.body==='string'&&!JSON.parse(options.body).ackToken){if(!await confirmInPage('这张卡已确认，修改后需重新确认。继续修改？',{continueLabel:'继续修改',signal:options.signal,focusOrigin:confirmationFocus}))throw Object.assign(Error('已取消修改'),{code:'CANCELLED'});const body=JSON.parse(options.body);return m2Fetch(input,{...options,confirmationFocus,body:JSON.stringify({...body,ackToken:value.reconfirmToken})});}if(value.code==='IDENTITY_CHANGED'){window.location.reload();throw Error(value.error);}}
 if(response.status===401){window.location.assign('/access');throw Error('登录已失效，请重新登录天枢');}
 if(response.status===403){let value;try{value=await response.clone().json();}catch{}throw Error(value?.error||'当前账号没有此项权限');}
 return response;
}
