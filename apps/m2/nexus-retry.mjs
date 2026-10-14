const backoff=[2000,8000,20000];
export function nexusRetry(status,count=0){
 if(status===409)return {retry:true,delay:1000,count};
 if((status===429||status>=500)&&count<backoff.length)return {retry:true,delay:backoff[count],count:count+1};
 return {retry:false,delay:0,count};
}
