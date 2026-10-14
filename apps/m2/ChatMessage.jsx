import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MemberAvatar from './MemberAvatar.jsx';
import BotAvatar from './BotAvatar.jsx';
import NexusOrb from './NexusOrb.jsx';

// Render text as React elements, never raw HTML. Remote images are not fetched.
export default function ChatMessage({author,name,text,thinking=false,quote,children}){
 return <div className={`message ${thinking?'message-thinking':''}`}>
  {author==='Nexus'?<span className="avatar nexus-avatar"><NexusOrb/></span>:author==='Agent'?<BotAvatar/>:<MemberAvatar name={author}/>}
  <div><small>{name||author}</small>{quote&&<blockquote className="message-quote">{quote.author}：{quote.text}</blockquote>}
   {thinking&&!text?<div className="agent-thinking" role="status">正在思考<span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span></div>:<div className="message-bubble"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={{a:({node,...props})=><a {...props} target="_blank" rel="noopener noreferrer"/>,img:({alt})=><span>{alt||'图片'}</span>}}>{String(text||'')}</Markdown></div>}
   {children}
  </div>
 </div>;
}
