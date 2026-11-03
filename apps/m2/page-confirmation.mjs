// A decision belongs to one request. A concurrent intent is cancelled, never joined.
let current=null;
const listeners=new Set();
const emit=()=>{for(const listener of listeners)listener();};
export const getPageConfirmation=()=>current;
export function subscribePageConfirmation(listener){listeners.add(listener);return()=>{listeners.delete(listener);if(!listeners.size)cancelPageConfirmation();};}
export function cancelPageConfirmation(){current?.choose(false);}
export function confirmInPage(message,{title='确认操作',continueLabel='继续',signal,focusOrigin}={}){
 if(current||signal?.aborted||!listeners.size)return Promise.resolve(false);
 return new Promise(resolve=>{
  const request={message,title,continueLabel,focusOrigin,choose(accepted){if(current!==request)return;current=null;signal?.removeEventListener('abort',abort);emit();resolve(accepted===true);}};
  const abort=()=>request.choose(false);
  current=request;signal?.addEventListener('abort',abort,{once:true});emit();
 });
}
