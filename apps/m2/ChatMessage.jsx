import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MemberAvatar from './MemberAvatar.jsx';
import BotAvatar from './BotAvatar.jsx';
import NexusOrb from './NexusOrb.jsx';
import {defaultUrlTransform} from 'react-markdown';
import {markMentions,isMention,markBold,isBold} from './mentions.mjs';
const urlTransform=u=>isMention(u)||isBold(u)?u:defaultUrlTransform(u);

// Render text as React elements, never raw HTML. Remote images are not fetched.
export default function ChatMessage({id,author,name,text,thinking=false,quote,notice=false,children}){
 return <div data-message-id={id} className={`message ${thinking?'message-thinking':''}${notice?' notice-message':''}`}>
  {author==='Nexus'?<span className="avatar nexus-avatar"><NexusOrb/></span>:author==='Agent'?<BotAvatar/>:<MemberAvatar name={author}/>}
  <div><small>{name||author}</small>{quote&&<blockquote className="message-quote">{quote.card?<span className="mention">{quote.label}</span>:<span className="mention">@{quote.author}</span>}：{quote.text}</blockquote>}
   {thinking&&!text?<div className="agent-thinking" role="status">正在思考<span className="thinking-dots" aria-hidden="true"><i/><i/><i/></span></div>:<div className="message-bubble"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={{a:({node,href,children,...props})=>isBold(href)?<strong>{children}</strong>:isMention(href)?<span className="mention">{children}</span>:<a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt})=><span>{alt||'图片'}</span>}}>{markMentions(markBold(text))}</Markdown></div>}
   {children}
  </div>
 </div>;
}
