export const profiles = {
  ceo: {label:'CEO', name:'刘明华', units:null, missions:null, maxDepth:1, handshake:'po'},
  dri: {label:'兼任 DRI', name:'模拟 DRI', units:['bf01','eo'], missions:null, maxDepth:2, handshake:['po','mission']},
  mission: {label:'Mission DRI', name:'模拟 Mission DRI', units:['bf01','eo'], missions:['bf01-m3','eo-m1','eo-m2'], maxDepth:3, handshake:['mission']},
};
export function normalize(units) {
  return units.map(u=>({...u,id:u.key,level:'po',version:1,status:'候选',children:u.missions.map((m,i)=>({...m,id:`${u.key}-m${i+1}`,unit:u.key,level:'mission',version:1,status:'候选',children:m.tasks.map((t,j)=>({...t,id:`${u.key}-m${i+1}-t${j+1}`,unit:u.key,level:'task',version:1,status:'候选',children:(t.activities||[]).map((a,k)=>({...a,id:`${u.key}-m${i+1}-t${j+1}-a${k+1}`,unit:u.key,level:'activity',version:1,status:'候选',children:[]}))}))}))}));
}
export function allNodes(units) {return units.flatMap(function visit(n){return [n,...n.children.flatMap(visit)]});}
export function isMine(n,p) {if(p.member)return n.level==='po'?(p.ceo||p.unitDri.includes(n.id)):p.missions.some(id=>n.id===id||n.id.startsWith(id+'-'))||p.unitDri.includes(n.unit);return p.missions ? p.missions.some(id=>n.id===id||n.id.startsWith(id+'-')) : !p.units||p.units.includes(n.unit||n.id);}
export function visibleUnits(units,p,mine=false) {return units.filter(u=>p.member?(!p.units||p.units.includes(u.id))&&(!mine||p.ceo||p.unitDri.includes(u.id)||p.missions.some(id=>id.startsWith(u.id+'-'))):!mine||!p.units||p.units.includes(u.id));}
export function canHandshake(n,p){if(p.member)return n.level==='po'&&(p.ceo||p.unitDri.includes(n.id))||n.level==='mission'&&(p.unitDri.includes(n.unit)||p.missions.includes(n.id));return [p.handshake].flat().includes(n.level)&&isMine(n,p);}
export function hasHandshake(n,p){return canHandshake(n,p)||n.children.some(c=>hasHandshake(c,p));}
export function defaultExpanded(units,p){return p.ceo||p.label==='CEO'?[]:units.filter(u=>p.units.includes(u.id)).flatMap(u=>[u.id,...(p.missions?u.children.filter(m=>p.member?p.missions.includes(m.id):isMine(m,p)).map(m=>m.id):[])]);}
export function viewContext(profile,scope,selection,expanded,scroll){return {profile,scope:scope||null,selection:selection?{id:selection.id,version:selection.version,level:selection.level}:null,expanded:[...expanded],viewport:scroll};}
