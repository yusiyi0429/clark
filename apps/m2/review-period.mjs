export const beijingDay=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export function monthEnd(period){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period||''))||Number(period.slice(0,4))<2000)throw Object.assign(Error('请选择有效的复盘月份'),{status:400});
 const [year,month]=period.split('-').map(Number);return `${period}-${String(new Date(Date.UTC(year,month,0)).getUTCDate()).padStart(2,'0')}`;
}
export function defaultReviewPeriod(now=new Date()){
 const day=beijingDay(now),[y,m]=day.split('-').map(Number);return `${m===1?y-1:y}-${String(m===1?12:m-1).padStart(2,'0')}`;
}
export function reviewTarget({period,cutoff},now=new Date()){
 const end=monthEnd(period),today=beijingDay(now);
 if(period>today.slice(0,7))throw Object.assign(Error('不能生成未来月份的复盘'),{status:400});
 if(typeof cutoff!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\+08:00$/.test(cutoff)||cutoff.slice(0,7)!==period||cutoff.slice(0,10)>end||Number(cutoff.slice(8,10))<1||!Number.isFinite(Date.parse(cutoff)))throw Object.assign(Error('证据截止时间必须是复盘月份内的有效北京时间'),{status:400});
 if(Date.parse(cutoff)>now.getTime())throw Object.assign(Error('证据截止时间不能晚于现在'),{status:400});
 return {period,cutoff};
}

export function reviewDay(at){
 const value=String(at||'');if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
 const parsed=new Date(value);return Number.isFinite(parsed.getTime())?beijingDay(parsed):'';
}
export function inReviewWindow(at,period,cutoff){
 const day=reviewDay(at);if(!day||day.slice(0,7)!==period)return false;
 if(!cutoff)return true;
 return /^\d{4}-\d{2}-\d{2}$/.test(String(at))?day<=reviewDay(cutoff):Date.parse(at)<=Date.parse(cutoff);
}
