import { monthDayTime } from "@/lib/companyTime";
import type { MissionGroupEntry } from "./missionCardGroup";
import s from "@/styles/mission-group.module.css";

/** 概念版 opening/workspace 的同一条公开时间线。开场不冒充用户意见。 */
export function MissionGroupTranscript({ entries }: { entries: MissionGroupEntry[] }) {
  if (!entries.length) return <p className={s.empty}>暂无消息</p>;
  return entries.map((entry) => {
    if (entry.type === "divider") return <p key={`divider:${entry.at}:${entry.text}`} className={s.divider}>{entry.text}</p>;
    if (entry.type === "opening") return <article key={`opening:${entry.at}`} className={s.message} data-opening><header><strong>Co-Agent</strong><time dateTime={entry.at}>{monthDayTime(entry.at)}</time></header><p>{entry.text}</p></article>;
    const f = entry.feedback;
    return <article className={s.message} key={f.id} data-feedback-id={f.id}>
      <header><strong>{f.authorName}</strong><time dateTime={f.createdAt}>{monthDayTime(f.createdAt)}</time></header>
      <div className={s.meta}>{f.kind === "suggestion" ? "修改建议" : f.kind === "quote" ? "引用评论" : "公开意见"}{f.sourceVersion ? ` · v${f.sourceVersion}` : ""}{f.late ? " · 截止后留言" : ""}</div>
      {f.quote ? <blockquote>{f.quote}</blockquote> : null}
      {f.original && f.kind === "suggestion" ? <blockquote><b>原文</b>{f.original}</blockquote> : null}
      {f.proposed ? <div className={s.proposed}><b>建议改为</b>{f.proposed}</div> : null}
      <p>{f.body}</p>
      <span className={s.verdict} data-tone={f.verdict.tone}>{f.verdict.text}</span>
    </article>;
  });
}
