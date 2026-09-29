"use client";

/**
 * 讨论与补充（Co-Agent Design 的 BR「讨论与补充」）：负责人、CEO 和本单元当月 Mission 负责人在复盘旁边说话，
 * 补充事实、风险和修订意见。不改正文——正文只由负责人改；确认后只读。
 */
import { useRef, useState } from "react";
import { Button } from "ts-design/primitives";
import type { TMonthlyReviewComment } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { postReviewComment, requestError } from "./reviewApi";
import s from "@/components/missionCards/mission-card.module.css";
import r from "./monthly-review.module.css";

export function ReviewDiscussion({ itemId, comments, participantNames, canComment, viewerId, onPosted }: {
  itemId: string;
  comments: TMonthlyReviewComment[];
  participantNames: string[];
  canComment: boolean;
  viewerId: string | null;
  onPosted: (comment: TMonthlyReviewComment) => void;
}) {
  const [draft, setDraft] = useState({ text: "", clientId: "" });
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  const send = async () => {
    const text = draft.text.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true; setPosting(true); setError("");
    // 原样重试复用同一个 clientId，服务端不会记两条。
    const clientId = draft.clientId || crypto.randomUUID();
    setDraft({ text: draft.text, clientId });
    try {
      onPosted(await postReviewComment(itemId, clientId, text));
      setDraft({ text: "", clientId: "" });
    } catch (cause) { setError(requestError(cause, "没有发出去，请检查网络后重试；输入已保留。")); }
    finally { inFlight.current = false; setPosting(false); }
  };

  return <section className={r.section} aria-label="讨论与补充">
    <h2>讨论与补充</h2>
    <p className={s.hint}>{participantNames.length ? `${participantNames.join("、")}（本单元 Mission 负责人）和 CEO 都能看到、都能补充。` : "CEO 和负责人都能看到、都能补充。"}正文只由负责人修改。</p>
    {comments.length ? <ol className={r.comments}>
      {comments.map((comment) => <li key={comment.id} className={r.comment} data-mine={comment.authorId === viewerId || undefined}>
        <header><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{monthDayTime(comment.createdAt)}</time></header>
        <p>{comment.body}</p>
      </li>)}
    </ol> : <p className={r.empty}>还没有人补充。</p>}
    {canComment ? <div className={r.composer}>
      <label htmlFor={`review-comment-${itemId}`} className={r.label}>补充事实、风险或修订意见</label>
      <textarea id={`review-comment-${itemId}`} value={draft.text} maxLength={2000} rows={3} disabled={posting}
        onChange={(event) => setDraft({ text: event.target.value, clientId: "" })}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
      {error ? <p className={s.proposalError} role="alert">{error}</p> : null}
      <div className={s.inlineActions}>
        <Button variant="primary" className={s.decisionPrimary} isDisabled={posting || !draft.text.trim()} onPress={() => void send()}>{posting ? "正在发送…" : "发送"}</Button>
      </div>
    </div> : null}
  </section>;
}
