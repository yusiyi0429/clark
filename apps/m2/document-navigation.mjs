export function responsibilityDocuments(units,profile){
 const owned=units.flatMap(u=>profile.unitDri.includes(u.id)?[u]:u.children.filter(m=>profile.missions.includes(m.id)));
 return profile.ceo?units:owned;
}
export function documentDepth(profile,node){
 if(!profile.ceo)return profile.maxDepth;
 // Reading depth is independent of the CEO's default collapsed view and signing rights.
 return 3;
}
// Home catalog sections: a member sees their own domain cards before the Missions they own elsewhere;
// the CEO sees battlefields and domains apart. Display-only grouping of the same list.
export function catalogGroups(catalog,profile){
 const isBattlefield=n=>String(n.name||'').startsWith('Battlefield');
 const groups=profile?.ceo
  ?[{key:'battlefield',title:'战场',items:catalog.filter(n=>n.level==='po'&&isBattlefield(n))},{key:'domain',title:'能力域',items:catalog.filter(n=>n.level==='po'&&!isBattlefield(n))},{key:'other',title:'其他',items:catalog.filter(n=>n.level!=='po')}]
  :profile?.member
   ?[{key:'unit',title:'我负责的领域',items:catalog.filter(n=>n.level==='po')},{key:'mission',title:'我负责的 Mission',items:catalog.filter(n=>n.level!=='po')}]
   :[{key:'all',title:'',items:catalog}];
 return groups.filter(g=>g.items.length);
}
// Root-to-node chain for the breadcrumb (PO › Mission › Task › Activity).
export function nodePath(units,id){
 const walk=(n,trail)=>{const next=[...trail,n];if(n.id===id)return next;for(const c of n.children||[]){const hit=walk(c,next);if(hit)return hit;}return null;};
 for(const u of units||[]){const hit=walk(u,[]);if(hit)return hit;}
 return [];
}
// Colour family per level: battlefield blue, domain green, mission yellow, task/activity neutral.
export function levelTone(node){
 if(!node)return 'task';
 if(node.level==='po')return String(node.name||'').startsWith('Battlefield')?'battlefield':'domain';
 return node.level==='mission'?'mission':node.level==='activity'?'activity':'task';
}
