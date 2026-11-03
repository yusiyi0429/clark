// This is a source projection, not a model summary or a reconstruction from title/commitment.
export function frozenAgreedOutcome(object,sourceBasis){
 const business=object?.business,items=[];
 for(const block of business?.blocks||[])for(const c of block.components||block.value?.components||[])if(c.type==='outcome'&&typeof c.text==='string'&&c.text.trim())items.push({text:c.text,sourceField:'outcome',componentRef:c.ref||null});
 if(!items.length&&typeof business?.result==='string'&&business.result.trim())items.push({text:business.result,sourceField:'result',componentRef:null});
 return {items,sourceBasis:structuredClone(sourceBasis||{}),missing:!items.length};
}
