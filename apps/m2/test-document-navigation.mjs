import {test} from 'node:test';
import assert from 'node:assert/strict';
import {responsibilityDocuments,documentDepth} from './document-navigation.mjs';
const units=[{id:'bf',name:'Battlefield B',children:[{id:'bf-m1',unit:'bf',level:'mission',children:[]},{id:'bf-m2',unit:'bf',level:'mission',children:[]}]},{id:'domain',name:'Domain D',children:[{id:'domain-m1',unit:'domain',level:'mission',children:[]}]}];
test('CEO 直接查看全部 RU PO，不建立公司 PO 占位',()=>{
 const p={ceo:true,name:'CEO',unitDri:['bf'],missions:['domain-m1'],maxDepth:1};
 const docs=responsibilityDocuments(units,p);assert.deepEqual(docs.map(n=>n.id),['bf','domain']);
 assert.equal(docs.some(n=>n.isCompany),false);
});
test('责任目录不重复列出已包含在本人 RU 下的 Mission；跨域 Mission 保留',()=>{
 const p={ceo:false,unitDri:['bf'],missions:['bf-m1','domain-m1']};
 assert.deepEqual(responsibilityDocuments(units,p).map(n=>n.id),['bf','domain-m1']);
 assert.deepEqual(responsibilityDocuments(units,{...p,unitDri:[]}).map(n=>n.id),['bf-m1','domain-m1']);
});
test('CEO 可主动深入所有 Task，阅读深度与默认展开层级分离',()=>{
 const p={ceo:true,unitDri:['bf'],missions:['domain-m1'],maxDepth:1};
 assert.equal(documentDepth(p,{id:'domain-m2',unit:'domain'}),3);
 assert.equal(documentDepth(p,{id:'bf-m2',unit:'bf'}),3);
 assert.equal(documentDepth(p,{id:'domain-m1-t1',unit:'domain'}),3);
});
