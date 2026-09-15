import { describe, it, expect } from 'vitest';
import { anchorsFromOntology, initialAnchors, issueLocation } from './radar-types';
import { assessedSignal, cleanUrl, validateAnchors, validateSources } from './radar-server';
import { calculateAssessment } from './mission-progress';
describe('radar grounding and routing',()=>{
 const hit={title:'企业服务推出新采购模式',url:'https://news.example.com/release?utm_source=test',sourceDomain:'news.example.com',snippet:'企业服务推出按实际结果验收的新采购模式，计划于本月底生效。',publishedAt:'2026-09-10'};
 const assessment={index:0,anchorId:initialAnchors[0].id,summary:'发布了新采购模式',implication:'需要重新审视验证承诺',unknown:'客户能否采用尚不确定',relevance:5,impact:5,actionable:5,issue:{title:'是否调整客户验证承诺？',judgment:'先验证影响范围',options:['保持当前承诺','调整验证边界'],fields:['lighthouse'] as ('lighthouse'|'tokenops')[],urgency:'yellow' as const,reason:'',quote:hit.snippet}};
 it('routes by unique impacted battlefields',()=>{expect(issueLocation(['lighthouse','lighthouse'])).toBe('lighthouse');expect(issueLocation(['lighthouse','tokenops'])).toBe('strategy');expect(issueLocation([])).toBeNull();});
 it('turns ontology monitoring into scanner anchors without issue-specific configuration',()=>{
   expect(anchorsFromOntology([{id:'d6',title:'D-06 TokenOps',material:'关注企业模型使用成本',scope:'业务域'}])[0]).toMatchObject({id:'d6',fields:['tokenops'],source:'公司本体 · 业务域'});
 });
 it('requires actual source support, high value, valid anchor and valid impact',()=>{
   const s=assessedSignal(hit,assessment,initialAnchors,'2026-09-11');expect(s?.issue).toBeDefined();expect(s?.url).toBe('https://news.example.com/release');expect(s?.anchorSnapshot.source).toBe(initialAnchors[0].source);
   expect(assessedSignal(hit,{...assessment,impact:2},initialAnchors,'now')?.issue).toBeUndefined();
   expect(assessedSignal(hit,{...assessment,issue:{...assessment.issue,quote:'不存在于来源中的一整段虚假证据'}},initialAnchors,'now')?.issue).toBeUndefined();
   expect(assessedSignal(hit,{...assessment,anchorId:'invented'},initialAnchors,'now')).toBeNull();
 });
 it('rejects unsafe links and malformed anchors',()=>{expect(cleanUrl('javascript:alert(1)')).toBeNull();expect(cleanUrl('http://127.0.0.1/api')).toBeNull();expect(()=>validateAnchors([{...initialAnchors[0],fields:[]}])).toThrow();});
 it('keeps manual monitoring sources public, normalized and unique',()=>{
   expect(validateSources([{id:'one',title:'监管机构',url:'https://example.com/news?utm_source=radar#latest'}])).toEqual([{id:'one',title:'监管机构',url:'https://example.com/news'}]);
   expect(()=>validateSources([{id:'one',title:'A',url:'https://example.com'},{id:'two',title:'B',url:'https://example.com/'}])).toThrow('已经添加');
   expect(()=>validateSources([{id:'local',title:'内网',url:'http://127.0.0.1'}])).toThrow();
 });
 it('does not turn unsupported urgency or duplicate options into decisions',()=>{
   expect(assessedSignal(hit,{...assessment,issue:{...assessment.issue,urgency:'red',reason:'需立即处理'}},initialAnchors,'now')?.issue?.urgency).toBe('yellow');
   expect(assessedSignal(hit,{...assessment,issue:{...assessment.issue,options:['保持','保持']}},initialAnchors,'now')?.issue).toBeUndefined();
 });
});
describe('mission arithmetic',()=>{
 const missions=[{id:'a',title:'a',completed:true,feedback:'done',difficulty:'easy'},{id:'b',title:'b',completed:false,feedback:'not started',difficulty:'hard'}];
 it('separates mission count from weighted completion',()=>{const r=calculateAssessment(missions,{items:[{id:'a',weight:1,completion:100,reason:'easy done'},{id:'b',weight:4,completion:0,reason:'hard not started'}]});expect(r.percent).toBe(20);expect(r.simplePercent).toBe(50);expect(r.completed).toBe(1);expect(r.total).toBe(2);});
 it('rejects missing, duplicated, nonfinite or contradictory assessments',()=>{for(const items of [[],[{id:'a',weight:1,completion:100,reason:'x'},{id:'a',weight:1,completion:100,reason:'x'}],[{id:'a',weight:1,completion:80,reason:'x'},{id:'b',weight:1,completion:0,reason:'x'}]])expect(()=>calculateAssessment(missions,{items})).toThrow();});
 it('does not report zero or NaN when no missions exist',()=>{expect(()=>calculateAssessment([],{items:[]})).toThrow();});
});
