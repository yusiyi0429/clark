import type { components } from "@/lib/api/schema";
import { monthDayTime } from "@/lib/companyTime";
import s from "@/styles/mission-group.module.css";

type Message = components["schemas"]["ThreadMessage"];

export function TaskGroupTranscript({ messages }: { messages: Message[] }) {
  if (!messages.length) return <p className={s.empty}>暂无消息</p>;
  return messages.map((message) => <article key={message.id} className={s.message} data-thread-message-id={message.id}>
    <header><strong>{message.kind === "co-agent" ? "Co-Agent" : message.authorName}</strong><time dateTime={message.createdAt}>{monthDayTime(message.createdAt)}</time></header>
    {message.quote ? <blockquote>{message.quote.text}</blockquote> : null}
    <p>{message.content}</p>
  </article>);
}
