import test from 'node:test';
import assert from 'node:assert/strict';
import {enterSubmit} from './enter-submit.mjs';
test('Enter提交，Shift换行，输入法确认和重复按键不提交',()=>{
 let sent=0,prevented=0;
 const event=extra=>({key:'Enter',preventDefault(){prevented++;},...extra});
 enterSubmit(event({}),()=>sent++);
 assert.equal(sent,1);assert.equal(prevented,1);
 for(const extra of [{shiftKey:true},{isComposing:true},{nativeEvent:{isComposing:true}},{keyCode:229},{repeat:true},{key:'a'}])enterSubmit(event(extra),()=>sent++);
 assert.equal(sent,1);assert.equal(prevented,1);
 enterSubmit(event({}),()=>sent++,false);assert.equal(sent,1);
});
