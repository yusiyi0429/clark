// Presentation-only numbering from the complete tree, never the filtered view.
// Battlefield and Domain each start at 1; Mission/Task belong to their parent.
export function orderPlanUnits(units){
 return [...units.filter(n=>n.name?.startsWith('Battlefield')),...units.filter(n=>!n.name?.startsWith('Battlefield'))];
}
export function planLabels(units){
 const labels=new Map();
 const visit=(node,index)=>{
  const kind=node.level==='po'?(node.name?.startsWith('Battlefield')?'Battlefield':'Domain'):{mission:'Mission',task:'Task',activity:'Activity'}[node.level]||'文档';
  // Mission and Task numbers have no leading zero (陈溪南 2026-10-23: a unit never has ten).
  const referenceLabel=`${kind} ${index+1}`;
  const groupName=node.level==='po'?String(node.name||'').replace(/^(?:Battlefield|Domain)\s*/,'').trim():undefined;
  labels.set(node.id,{referenceLabel,planLabel:node.level==='po'?`${referenceLabel} ${groupName}`:referenceLabel,...(groupName?{groupName}:{})});
  (node.children||[]).forEach(visit);
 };
 const positions={Battlefield:0,Domain:0};
 units.forEach(node=>{const kind=node.name?.startsWith('Battlefield')?'Battlefield':'Domain';visit(node,positions[kind]++);});return labels;
}
