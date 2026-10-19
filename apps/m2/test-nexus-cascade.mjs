import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationState,applyAction,currentVersion} from './governance.mjs';
import {cascadeRules,cascadeInput,validateCascade,cascadeMessage} from './nexus-cascade.mjs';
// 下级对齐 (陈溪南 2026-10-19): an upper change is checked against each card below; only misfits get a card.
const m1={id:'bf01-m1',unit:'bf01',level:'mission',title:'首轮研究',owner:'孙铭泽',version:1,tier:'P1',result:'王总用一次',checks:['**首用：**10/29 用一次'],children:[]};
const m2={id:'bf01-m2',unit:'bf01',level:'mission',title:'正式资料',owner:'于斯一',version:1,tier:'P0',result:'资料接好',children:[]};
const seed=()=>createCollaborationState([{id:'bf01',level:'po',title:'灯塔',owner:'刘明华',version:1,result:'王总用一次',children:[m1,m2]}]);
const dri={id:'dri',name:'刘明华',visibleUnits:['bf01'],unitDri:['bf01']};
test('上级改了排进下级对齐，群里说明 Nexus 正在对照',()=>{
 const s=applyAction(seed(),dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{result:'王总两周内用两次并做出决定'}});
 assert.equal(s.cascadeQueue.length,1);assert.deepEqual([s.cascadeQueue[0].cardId,s.cascadeQueue[0].from,s.cascadeQueue[0].to],['bf01',1,2]);
 assert.match(s.messages.at(-1).text,/正在按拆解规则对照下级 2 张卡/);
 const input=cascadeInput(s,'bf01',1);
 assert.deepEqual(input.parent.changedFields,['result']);assert.equal(input.parent.before.result,'王总用一次');assert.equal(input.children.length,2);
});
test('只给对不上的下级出卡，并 @ 负责人；对得上的说不用改',()=>{
 const s=applyAction(seed(),dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{result:'王总两周内用两次并做出决定'}});
 const checked=validateCascade({children:[{cardId:'bf01-m1',aligned:false,why:'验收还是只用一次',patch:{checks:['**两次使用：**两周内用两次']}},{cardId:'bf01-m2',aligned:true,why:'资料接入不受影响'},{cardId:'eo-m1',aligned:false,patch:{result:'x'}}]},{state:s,parentId:'bf01'});
 assert.deepEqual(checked.proposals.map(p=>p.cardId),['bf01-m1']);assert.deepEqual(checked.aligned,['bf01-m2']);
 const text=cascadeMessage(s,'bf01',checked);
 assert.match(text,/M01（验收还是只用一次），已出修订卡，请 @孙铭泽 看看/);assert.match(text,/M02 对得上，不用改/);
});
test('列表写成一句话、档位乱写都不出卡，并请负责人自己看',()=>{
 const s=applyAction(seed(),dri,{type:'revise',cardId:'bf01',baseVersion:1,patch:{result:'新'}});
 const checked=validateCascade({children:[{cardId:'bf01-m1',aligned:false,patch:{checks:'一句话'}},{cardId:'bf01-m2',aligned:false,patch:{tier:'P5'}}]},{state:s,parentId:'bf01'});
 assert.equal(checked.proposals.length,0);assert.equal(checked.rejected.length,2);
 assert.match(cascadeMessage(s,'bf01',checked),/没核对出结论，请 @孙铭泽、@于斯一 自己看一下/);
});
test('判断规则来自技能的修订规则，没有就不做',()=>{
 assert.match(cascadeRules('\n--- SKILL.md ---\nA\n--- references/revision-loop.md ---\n影响沿真实依赖传播'),/影响沿真实依赖传播/);
 assert.throws(()=>cascadeRules('\n--- SKILL.md ---\nA'),/revision-loop/);
});
