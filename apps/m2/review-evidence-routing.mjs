// A snapshot can be temporarily filed in one unit while individual paragraphs
// explicitly name another business unit. Only move those marked paragraphs.
export function splitBusinessEvidence(text,sourceUnit,resolveUnit){
 const lines=String(text||'').split('\n'),remaining=[],routed=[];
 for(let i=0;i<lines.length;){
  const marker=lines[i].match(/^\s*(?:\d+[.、．)]\s*|[-*]\s*)?【临时归档[；;，,]\s*业务归属[：:]\s*([^】]+)】/);
  const unit=marker&&resolveUnit(marker[1].trim());
  if(!unit||unit===sourceUnit){remaining.push(lines[i++]);continue;}
  const part=[lines[i++]];
  while(i<lines.length&&!/^\s*(?:\d+[.、．)]\s|[-*]\s|【|(?:来源与缺口|覆盖)[：:])/.test(lines[i]))part.push(lines[i++]);
  routed.push({unit,text:part.join('\n').trim()});
 }
 return {text:remaining.join('\n').trim(),routed};
}
