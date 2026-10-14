import roster from './account-responsibilities.pending.json' with {type:'json'};
export const memberProfiles=Object.fromEntries(roster.accounts.map(a=>[a.id,{
 member:true,ceo:a.ceo,name:a.name,label:a.name,unitDri:a.unitDri,
 units:a.ceo?null:a.visibleUnits,missions:a.missionDri,maxDepth:a.ceo?1:3,
 summary:a.ceo?'CEO · 公司整体':`${a.unitDri.length?`${a.unitDri.length} 个领域 DRI · `:''}${a.missionDri.length} 个 Mission`,
}]));
