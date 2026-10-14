export function selectDiscussion(messages,{shared,scope}){
 return (Array.isArray(messages)?messages:[]).slice(-20)
  .filter(m=>m.channel===(shared?'group':'private')&&(!shared||m.scope===scope))
  .map(m=>({author:String(m.author).slice(0,80),text:String(m.text).slice(0,8000)}));
}
