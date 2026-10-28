// 现在是什么时候 (孙铭泽 10/27 in the Chat tests, adopted for M2 by 陈溪南): the model is told the Beijing date, the week and the
// month on every turn, so 今天、这周、上周、月底 are worked out from it instead of asking the user. Kept in the turn's input,
// not the system prompt, so a stored turn still says which day it was.
const WEEKDAYS=['周日','周一','周二','周三','周四','周五','周六'];
const bj=ms=>new Date(ms+8*3600e3);
const day=d=>`${d.toISOString().slice(0,10)} ${WEEKDAYS[d.getUTCDay()]}`;
export function nowContext(at=Date.now()){
 const ms=typeof at==='number'?at:Date.parse(at),d=bj(ms),monday=bj(ms-((d.getUTCDay()+6)%7)*86400e3),sunday=bj(Date.parse(monday.toISOString())-8*3600e3+6*86400e3);
 const lastMonday=bj(Date.parse(monday.toISOString())-8*3600e3-7*86400e3),lastSunday=bj(Date.parse(monday.toISOString())-8*3600e3-86400e3);
 const monthEnd=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0));
 return {at:`${day(d)} ${d.toISOString().slice(11,16)}（北京时间）`,week:`${day(monday)} 至 ${day(sunday)}`,lastWeek:`${day(lastMonday)} 至 ${day(lastSunday)}`,month:d.toISOString().slice(0,7),monthEnd:day(monthEnd)};
}
export const NOW_RULE='今天、这周、上周、本月、月底都按输入里的 now 换算，不反问用户。';
