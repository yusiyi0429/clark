import test from 'node:test';
import assert from 'node:assert/strict';
import {withReviewSources} from './review-sources.mjs';

const fact=(unit,kind,title,factThrough)=>({id:title,unit,kind,sourceRef:'event:'+title,title,text:title+' 正文',factThrough,confirmation:'unconfirmed'});
const input={period:'2026-11',audit:{},sources:[
 {key:'company',facts:[fact('company','lto','公司六个月目标'),fact('company','review','10 月公司复盘','2026-10-31T23:59:59+08:00')]},
 {key:'bf01',facts:[fact('bf01','review','【10 月 PO】灯塔','2026-10-31T23:59:59+08:00'),fact('bf01','review','9 月灯塔复盘','2026-09-30T23:59:59+08:00')]}]};
const pkg={fromPeriod:'2026-10',forPeriod:'2026-11',reviewRound:'10 月复盘',
 company:{id:'rv:company',version:2,title:'公司 10 月复盘',owner:'刘明华',verdict:'部分达成',verdictReason:'灯塔首用推迟',causes:['资料晚到'],nextInputs:['先保王总首用']},
 units:[{unit:'bf01',po:{id:'rv:bf01',version:1,title:'灯塔',verdict:'未达成',causes:[],nextInputs:['11/10 前首用']},missions:[{id:'rv:bf01-m1',version:3,title:'首用',verdict:'未达成'}]},
  {unit:'old-unit',po:{id:'rv:old',version:1,title:'旧单元',verdict:'达成'}}]};

test('confirmed reviews become last month results under their unit and replace the ontology review of that month',()=>{
 const out=withReviewSources(input,pkg),by=k=>out.sources.find(s=>s.key===k);
 assert.deepEqual(by('company').facts.map(f=>f.title),['公司六个月目标','10 月复盘（已确认第 2 版）：公司 10 月复盘（刘明华）','10 月复盘（已确认第 1 版）：旧单元']);
 assert.deepEqual(by('bf01').facts.map(f=>f.title),['【10 月 PO】灯塔','9 月灯塔复盘','10 月复盘（已确认第 1 版）：灯塔','10 月复盘（已确认第 3 版）：首用']);
 assert.match(by('company').content,/\*\*结论：\*\*部分达成。灯塔首用推迟\n\*\*原因：\*\*\n- 资料晚到\n\*\*给下月的输入：\*\*\n- 先保王总首用/);
 assert.ok(by('bf01').facts.every(f=>f.kind!=='review'||f.factThrough));
 assert.deepEqual(out.audit.reviewHandoff,{fromPeriod:'2026-10',forPeriod:'2026-11',reviewRound:'10 月复盘',added:4,replacedOntologyReviews:1,placedInCompany:['old-unit']});
 assert.notEqual(by('bf01').hash,undefined);
});
