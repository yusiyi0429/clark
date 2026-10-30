import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturePageFocus,restoreConfirmationFocus,cancelFocusRestore} from './confirmation-focus.mjs';
test('焦点在请求前保留，关闭时按钮仍禁用则等恢复；不抢新操作的焦点',()=>{
 const keys=['document','MutationObserver','requestAnimationFrame','cancelAnimationFrame'],saved=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
 const frames=[];let mutation,disconnected=0,focused=0;
 const body={},other={},button={isConnected:true,disabled:false,getAttribute:()=>null,focus(){focused++;globalThis.document.activeElement=button;}};
 globalThis.document={body,documentElement:{},activeElement:button};
 globalThis.MutationObserver=class{constructor(cb){mutation=cb;}observe(){}disconnect(){disconnected++;}};
 globalThis.requestAnimationFrame=cb=>{frames.push(cb);return frames.length;};globalThis.cancelAnimationFrame=()=>{};
 try{
  const origin=capturePageFocus();assert.equal(origin,button);button.disabled=true;globalThis.document.activeElement=body;assert.equal(capturePageFocus(),null);assert.equal(capturePageFocus({target:button}),button);assert.equal(capturePageFocus({currentTarget:button,target:other}),button);
  restoreConfirmationFocus(origin);frames.shift()();assert.equal(focused,0);button.disabled=false;mutation();assert.equal(focused,1);assert.ok(disconnected);
  globalThis.document.activeElement=body;button.disabled=true;restoreConfirmationFocus(button);frames.shift()();globalThis.document.activeElement=other;button.disabled=false;mutation();assert.equal(focused,1);
  globalThis.document.activeElement=body;button.isConnected=false;restoreConfirmationFocus(button);frames.shift()();assert.equal(focused,1);
  button.isConnected=true;restoreConfirmationFocus(button);cancelFocusRestore();frames.shift()();assert.equal(focused,1);
 }finally{cancelFocusRestore();for(const k of keys)if(saved[k]===undefined)delete globalThis[k];else globalThis[k]=saved[k];}
});
