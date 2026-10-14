import test from 'node:test';
import assert from 'node:assert/strict';
import {memberProfiles} from './member-profiles.mjs';
import {visibleUnits,isMine,defaultExpanded} from './domain.mjs';
import {canPreviewRevise} from './review-workflow.mjs';
test('九位已确认成员：共享可见范围不随关闭本人筛选扩大，兼任职责正确修订',()=>{
 assert.equal(Object.keys(memberProfiles).length,9);
 const p=memberProfiles['member-02'];
 const units=['bf01','method','eo'].map(id=>({id,level:'po',children:[]}));
 assert.deepEqual(visibleUnits(units,p,false).map(u=>u.id),['bf01','method']);
 assert.ok(isMine({id:'method-m3',unit:'method',level:'mission'},p));
 assert.ok(canPreviewRevise({id:'method',level:'po'},'member-02',p));
 assert.ok(canPreviewRevise({id:'bf01-m1-t1',level:'task'},'member-02',p));
 assert.equal(canPreviewRevise({id:'method-m3',level:'mission'},'member-02',p),false);
 assert.equal(canPreviewRevise({id:'bf01',level:'po'},'member-02',p),false);
 assert.deepEqual(defaultExpanded(units,memberProfiles['member-01']),[]);
});
