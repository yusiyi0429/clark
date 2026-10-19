// Live Feishu templates checked 2026-10-11. Views share object fields, not copied plans.
export const templateSources={
 combined:{revision:372,url:'https://tokenking.feishu.cn/wiki/W19QwmtKNiVcIck9acDcwDKxnQh'},
 missionExample:{revision:142,url:'https://tokenking.feishu.cn/wiki/X7nDwCzXoi0cxnkbTydcm9ZonKd'},
 po:{version:'v1.2',revision:14,url:'https://tokenking.feishu.cn/wiki/YXwnwDVQ3iaxtGkImMfc2fSXnIb'},
 mission:{version:'v0.1',revision:30,url:'https://tokenking.feishu.cn/wiki/E2QywBfU5i3bEvkNcIVc8esTn8f'},
 task:{version:'v0.3',revision:0,url:'https://tokenking.feishu.cn/wiki/DtzkwafWHiiYmektjAwch0RhnEc'},
};
export const templateFields={
 po:{core:[['result','成果描述'],['time','时间边界']],detail:[['why','存在必要性'],['checks','验收标准'],['boundary','责任边界']],plan:[['logic','核心路径'],['tradeoff','关键取舍'],['dependencies','约束与依赖'],['milestones','里程碑']]},
 mission:{core:[['result','成果描述'],['time','时间边界'],['checks','验收标准']],detail:[['why','存在必要性'],['boundary','责任边界']],plan:[['path','核心路径'],['tradeoff','关键取舍'],['dependencies','约束与依赖'],['milestones','里程碑']]},
 task:{core:[['result','工作结果'],['time','时间边界'],['checks','成功／验收标准']],detail:[['why','存在必要性'],['boundary','工作边界']]},
 activity:{core:[['result','预期产出'],['time','时间边界'],['checks','成功／通过标准']],detail:[]},
};
// Human view (template v0.3, 2026-10-15): each card shows the few fields its owner judges; everything else stays, folded.
export const cardFields={
 po:{key:[['result','本期成果'],['checks','验收标准'],['expectedProgress','上级 LTO 贡献']],more:[['why','存在必要性'],['boundary','责任边界'],['logic','核心路径'],['tradeoff','关键取舍'],['dependencies','约束与依赖'],['milestones','里程碑'],['parentLtoReference','对应 LTO']]},
 mission:{key:[['result','成果'],['checks','验收标准'],['boundary','责任边界']],more:[['why','存在必要性'],['path','核心路径'],['tradeoff','关键取舍'],['dependencies','约束与依赖（含跨领域供需）'],['milestones','里程碑']]},
 task:{key:[['result','工作结果'],['checks','验收标准'],['boundary','工作边界']],more:[['why','存在必要性'],['dependsOn','前置依赖']]},
 activity:{key:[['result','预期产出'],['checks','通过标准']],more:[['inputs','必要输入与约束'],['rollback','没通过怎么办'],['boundary','边界'],['why','存在必要性']]},
};
export const listFields=new Set(['checks','milestones','dependsOn']);
export function documentFieldLabel(level,key){
 if(key==='title')return '名称';
 if(key==='card')return '整张卡片';
 if(key==='owner')return level==='mission'?'Mission DRI':'负责人';
 if(key==='unitName')return '所属责任单元';
 if(key==='childList')return level==='po'?'Mission 清单':'Task 清单';
 if(key==='handoffs')return '交付衔接';
 if(key==='parentLtoReference')return '对应 LTO';
 if(key==='expectedProgress')return '上级 LTO 贡献';
 if(key==='dependsOn')return '前置依赖';
 const t=templateFields[level]||templateFields.activity;
 return [...t.core,...t.detail,...(t.plan||[]),...(t.extra||[])].find(([field])=>field===key)?.[1]||key;
}
export function editableTemplateFields(level,node={}){
 const t=templateFields[level]||templateFields.activity;
 return [['title','名称'],...t.core,...(t.detail||[]),...(t.plan||[]),...(t.extra||[]),...(level==='po'&&node.handoffs?[['handoffs','交付衔接（历史字段）']]:[]),...(level==='po'&&node.parentLtoReference?[['parentLtoReference','对应 LTO（历史字段）']]:[])];
}
