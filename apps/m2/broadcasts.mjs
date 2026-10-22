// Group-wide notices from Nexus (陈溪南 2026-10-21): things everyone in a battlefield or domain needs to know or act on
// are posted with @所有人; anything that concerns only some people keeps @-ing just them.
export const EVERYONE='所有人';
export function broadcast(state,scope,text,{kind='broadcast',now=new Date().toISOString()}={}){
 state.sequence=(state.sequence||0)+1;
 state.messages.push({id:`broadcast-${state.sequence}`,author:'Nexus',channel:'group',scope,general:true,broadcast:kind,text:`@${EVERYONE} ${text}`,createdAt:now});
 return state;
}
const monthOf=period=>{const m=String(period||'').match(/-(\d{2})$/);return m?`${Number(m[1])} 月`:'';};
export const reviewMonth=state=>monthOf(state.reviewRound?.period)||'本月';
