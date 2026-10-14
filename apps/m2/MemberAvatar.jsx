import React from 'react';
import {memberProfiles} from './member-profiles.mjs';
export function memberIdFor(name){return Object.keys(memberProfiles).find(id=>memberProfiles[id].name===name);}
export default function MemberAvatar({name,className=''}){
 const id=memberIdFor(name);
 return <span className={`avatar member-portrait ${className}`} aria-label={`${name}的头像`}>{id?<img src={`/m2/avatars/${id}.png`} alt=""/>:name?.slice(0,1)}</span>;
}
