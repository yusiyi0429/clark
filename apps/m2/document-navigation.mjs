export function responsibilityDocuments(units,profile){
 const owned=units.flatMap(u=>profile.unitDri.includes(u.id)?[u]:u.children.filter(m=>profile.missions.includes(m.id)));
 return profile.ceo?units:owned;
}
export function documentDepth(profile,node){
 if(!profile.ceo)return profile.maxDepth;
 // Reading depth is independent of the CEO's default collapsed view and signing rights.
 return 3;
}
