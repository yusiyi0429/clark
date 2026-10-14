export const ganttMonth={year:2026,month:10,days:31,dayWidth:36,labelWidth:320};
export function poPeriod(month=ganttMonth){const prefix=`${month.year}-${String(month.month).padStart(2,'0')}`;return `${prefix}-01—${prefix}-${String(month.days).padStart(2,'0')}`;}
export function ganttCardPeriod(node,month=ganttMonth){return ganttPeriod(node.time,month);}
export function ganttPeriod(value,month=ganttMonth){
 const dates=String(value||'').match(/\d{4}[./-]\d{1,2}[./-]\d{1,2}/g);
 if(!dates?.length||dates.length>2)return null;
 const parsed=dates.map(s=>{const [y,m,d]=s.split(/[./-]/).map(Number),date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?{y,m,d,date:date.getTime()}:null;});
 if(parsed.some(d=>!d))return null;
 const [start,end=parsed[0]]=parsed;
 if(start.date>end.date)return null;
 const min=Date.UTC(month.year,month.month-1,1),max=Date.UTC(month.year,month.month-1,month.days);
 if(end.date<min||start.date>max)return null;
 const first=Math.max(start.date,min),last=Math.min(end.date,max),day=86400000;
 return {left:(first-min)/day*month.dayWidth,width:((last-first)/day+1)*month.dayWidth,label:start.date===end.date?`${start.m}.${start.d}`:`${start.m}.${start.d}—${end.m}.${end.d}`};
}
