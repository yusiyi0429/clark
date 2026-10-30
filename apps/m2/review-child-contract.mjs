// Input provenance, never a rewritten review. Success criteria are not Task/Mission objects.
const text=x=>String(x||''),ref=x=>text(x).replace(/^rv:/,'');
export function objectExclusion(object,id,cutoff){
 const life=object?.records?.lifecycle||object?.business?.lifecycle||{},status=life.status||life.display_name;
 if(!['cancelled','canceled','withdrawn','superseded','已取消','已撤销','已替换','已移出'].includes(status))return null;
 const at=life.occurred_at||life.updated_at||life.at||null;if(at&&cutoff&&at>cutoff)return null;
 return {ref:id,reason:status,authority:`${id}@${object?.business?.version??'?'}#lifecycle`,effectiveAt:at};
}
export function childContract(items,excluded=[],gaps=[]){
 const missing=[...gaps];if(new Set(items.map(x=>x.ref)).size!==items.length)missing.push('有效直接子项存在重复引用');for(const x of items)if(!x.ref||!x.parentRef||!x.version)missing.push(`直接子项 ${x.ref||'未知'} 缺稳定引用、父级或有效版本`);
 return {complete:missing.length===0,items,excluded,...(missing.length?{missing:[...new Set(missing)]}:{})};
}
export function childVerdictProblem(review,contract,{childReviews=[]}={}){
 if(!contract?.complete)return '有效直接子项元信息不完整，请重新读取；不能按无子项处理';
 const items=contract.items||[];if(!items.length)return review.verdict==='部分达成'?'本来无有效直接子项时只用达成或未达成':null;
 const rows=review.facts||[],statuses=[];
 for(const item of items){const matches=rows.filter(f=>ref(f.ref)===ref(item.ref));if(matches.length!==1)return `有效直接子项 ${item.ref} 缺唯一事实行`;
  const child=childReviews.find(c=>ref(c.ref)===ref(item.ref));if(item.kind==='Mission'&&!child)return `有效Mission ${item.ref} 缺本轮子复盘判定`;
  if(child&&child.verdict!==matches[0].status)return `Mission ${item.ref} 行状态与本轮直接子复盘判定不一致`;
  statuses.push(matches[0].status);
 }
 const count=statuses.filter(s=>s==='达成').length;
 if(!count&&review.verdict!=='未达成')return '有效直接子项0项达成，总体必须为未达成';
 if(count&&count<items.length&&review.verdict!=='部分达成')return '已有有效直接子项达成但非全部达成，总体必须为部分达成';
 if(count===items.length&&!['达成','部分达成'].includes(review.verdict))return '有效直接子项已全部达成，总体须由自身成果及必要条件在达成或部分达成中判断';
 return null;
}
