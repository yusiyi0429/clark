import {memberProfiles} from './member-profiles.mjs';
// Generated owners may carry a candidate marker such as “白田田（候选）”; match the person, not the decoration.
export function ownerName(value){
 const text=String(value??'').trim().replace(/^(?:待确认)?候选\s*[：:]\s*/,'');
 return Object.values(memberProfiles).map(p=>p.name).find(n=>text===n||text.startsWith(n+'（')||text.startsWith(n+' ('))||text;
}
