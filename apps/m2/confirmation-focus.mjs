// Capture before a request can disable its initiating control.
export function capturePageFocus(){
 const doc=globalThis.document,element=doc?.activeElement;
 return element&&element!==doc.body&&element!==doc.documentElement?element:null;
}
let stopPrevious=()=>{};
export function cancelFocusRestore(){stopPrevious();}
export function restoreConfirmationFocus(element){
 stopPrevious();
 const doc=globalThis.document;
 if(!doc||!element)return;
 let observer,timer,frame,stopped=false;
 const stop=()=>{stopped=true;observer?.disconnect();clearTimeout(timer);if(frame!==undefined)globalThis.cancelAnimationFrame(frame);};
 stopPrevious=stop;
 const restore=()=>{
  if(stopped)return;
  if(!element.isConnected){stop();return;}
  // A later user action or another dialog owns focus now.
  const active=doc.activeElement;
  if(active&&active!==doc.body&&active!==doc.documentElement&&active!==element){stop();return;}
  if(element.disabled||element.getAttribute?.('aria-disabled')==='true')return;
  element.focus({preventScroll:true});stop();
 };
 // React may re-enable the submit button after the dialog has closed.
 observer=new MutationObserver(restore);observer.observe(element,{attributes:true,attributeFilter:['disabled','aria-disabled','data-disabled']});
 timer=setTimeout(stop,30000);
 frame=globalThis.requestAnimationFrame(restore);
}
