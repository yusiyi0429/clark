import { useEffect, useRef } from "react";
import type { components } from "@/lib/api/schema";
import { monthDayTime } from "@/lib/companyTime";
import s from "@/styles/mission-group.module.css";

type Message = components["schemas"]["ThreadMessage"];

/** highlightId：Co-Agent 胶囊正为这一段出现（新人进群时它讲的来龙去脉），这段同时亮一下、滚到看得见。 */
export function TaskGroupTranscript({ messages, highlightId }: { messages: Message[]; highlightId?: number }) {
  const highlighted = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlightId !== undefined) highlighted.current?.scrollIntoView({ block: "nearest" });
  }, [highlightId]);
  if (!messages.length) return <p className={s.empty}>暂无消息</p>;
  return messages.map((message) => <article key={message.id} ref={message.id === highlightId ? highlighted : undefined} className={s.message} data-thread-message-id={message.id} data-coagent-said={message.id === highlightId || undefined}>
    <header><strong>{message.kind === "co-agent" ? "Co-Agent" : message.authorName}</strong><time dateTime={message.createdAt}>{monthDayTime(message.createdAt)}</time></header>
    {message.quote ? <blockquote>{message.quote.text}</blockquote> : null}
    <p>{message.content}</p>
  </article>);
}
