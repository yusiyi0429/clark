import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturePageFocus,restoreConfirmationFocus,cancelFocusRestore} from './confirmation-focus.mjs';
test('焦点保留：等禁用恢复及modal释放，只在实际聚焦后结束；不抢新用户焦点',()=>{
 const keys=['document','MutationObserver','requestAnimationFrame','cancelAnimationFrame'],saved=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
 const frames=[];let mutation,disconnected=0,focused=0,inert=false;
 const body={},other={},cancel={},dialog={open:false,contains:element=>element===cancel};
 const button={isConnected:true,disabled:false,getAttribute:()=>null,focus(){if(inert)return;focused++;globalThis.document.activeElement=button;}};
 globalThis.document={body,documentElement:{},activeElement:button};
 globalThis.MutationObserver=class{constructor(cb){mutation=cb;}observe(){}disconnect(){disconnected++;}};
 globalThis.requestAnimationFrame=cb=>{frames.push(cb);return frames.length;};globalThis.cancelAnimationFrame=()=>{};
 try{
  const origin=capturePageFocus();assert.equal(origin,button);button.disabled=true;globalThis.document.activeElement=body;assert.equal(capturePageFocus(),null);assert.equal(capturePageFocus({target:button}),button);assert.equal(capturePageFocus({currentTarget:button,target:other}),button);
  restoreConfirmationFocus(origin);assert.equal(focused,0);button.disabled=false;mutation();assert.equal(focused,1);assert.ok(disconnected);
  // A disabled attribute change can arrive before the closed modal releases inertness.
  globalThis.document.activeElement=cancel;inert=true;const before=disconnected;restoreConfirmationFocus(button,{closingDialog:dialog});assert.equal(focused,1);assert.equal(disconnected,before);assert.equal(frames.length,1);
  frames.shift()();assert.equal(focused,1);assert.equal(disconnected,before);inert=false;frames.shift()();assert.equal(focused,2);assert.equal(globalThis.document.activeElement,button);assert.ok(disconnected>before);
  globalThis.document.activeElement=body;button.disabled=true;restoreConfirmationFocus(button);globalThis.document.activeElement=other;button.disabled=false;mutation();assert.equal(focused,2);
  globalThis.document.activeElement=body;button.isConnected=false;restoreConfirmationFocus(button);assert.equal(focused,2);
  button.isConnected=true;inert=true;restoreConfirmationFocus(button);cancelFocusRestore();inert=false;frames.shift()();assert.equal(focused,2);
 }finally{cancelFocusRestore();for(const k of keys)if(saved[k]===undefined)delete globalThis[k];else globalThis[k]=saved[k];}
});
