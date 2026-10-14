import test from 'node:test';
import assert from 'node:assert/strict';
import {canHandshake,hasHandshake} from './domain.mjs';
const task={id:'bf-m1-t1',unit:'bf',level:'task',children:[]};
const mission={id:'bf-m1',unit:'bf',level:'mission',children:[task]};
const unit={id:'bf',level:'po',children:[mission]};
test('只看本人握手：Task不入选，不用CEO身份绕过Mission责任',()=>{
 const ceo={member:true,ceo:true,unitDri:[],missions:[]};
 assert.equal(canHandshake(unit,ceo),true);assert.equal(canHandshake(mission,ceo),false);assert.equal(canHandshake(task,ceo),false);
 const owner={...ceo,ceo:false,missions:['bf-m1']};
 assert.equal(canHandshake(unit,owner),false);assert.equal(hasHandshake(unit,owner),true);assert.equal(canHandshake(mission,owner),true);assert.equal(hasHandshake(task,owner),false);
 const dri={...owner,missions:[],unitDri:['bf']};
 assert.equal(canHandshake(unit,dri),true);assert.equal(canHandshake(mission,dri),true);assert.equal(canHandshake(task,dri),false);
});
