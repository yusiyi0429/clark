// A person page contains several real review cards. Comments belong to the card,
// never to the synthetic person-page id; keep the version seen when writing began.
export const fieldCommentTarget=(node,field)=>({id:node.id,version:node.version,level:node.level,field});
export const fieldCommentActive=(annotation,id,field)=>annotation?.anchor===field&&(!annotation.cardId||annotation.cardId===id);
export function fieldCommentAction(target,text){
 const [block,item]=String(target.field||'card').split('#');
 return {type:'comment',cardId:target.id,baseVersion:target.version,text,block,...(item!==undefined?{item:Number(item)}:{})};
}
