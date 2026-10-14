// Enter submits; Shift+Enter adds a line. IME confirmation must never submit.
export function enterSubmit(event,submit,enabled=true){
 if(event.key!=='Enter'||event.shiftKey||event.nativeEvent?.isComposing||event.isComposing||event.keyCode===229||event.nativeEvent?.keyCode===229||event.repeat)return;
 event.preventDefault();
 if(enabled)submit();
}
