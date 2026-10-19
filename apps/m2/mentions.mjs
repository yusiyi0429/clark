import {memberProfiles} from './member-profiles.mjs';
// @ a real member (or Nexus) reads as a mention: turned into a markdown link the chat renders as a blue tag.
const names=[...new Set([...Object.values(memberProfiles).map(p=>p.name),'Nexus'])].sort((a,b)=>b.length-a.length);
const pattern=new RegExp(`[@＠](${names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})`,'g');
export function markMentions(text){return String(text||'').replace(pattern,(_,name)=>`[@${name}](mention:${encodeURIComponent(name)})`);}
export const isMention=href=>String(href||'').startsWith('mention:');
// "**验收：**孙铭泽…": markdown will not close bold after a full-width colon followed by Chinese, so the stars leak.
// Turn each **…** into a link the chat renders as bold.
export function markBold(text){return String(text||'').replace(/\*\*([^*\n]+?)\*\*/g,(_,inner)=>`[${inner.replace(/[[\]]/g,'')}](bold:)`);}
export const isBold=href=>String(href||'')==='bold:';
