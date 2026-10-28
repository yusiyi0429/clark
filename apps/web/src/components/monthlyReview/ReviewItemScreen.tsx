"use client";

/**
 * 复盘项页（M1B 会议共识 · spec §6.1）：左边是本月目标和四栏自评，右边是本人和自己 Agent 的对话（外壳按 scope 挂上）。
 * 负责人直接改、提交；Agent 在对话里只提改写建议，负责人点「采用」才写入。CEO 看评估，确认或打回（必须写原因）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "ts-design/primitives";
import type { TMonthlyReviewField, TMonthlyReviewItemPayload } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useConfirm } from "@/components/ConfirmDialog";
import { FIELD_HINTS, FIELD_LABELS, FIELDS, OPTIONAL_FIELDS, itemStatusText, monthOf, requestError, runReviewAction, ReviewActionError, type ReviewAction } from "./reviewApi";
import { ReviewDiscussion } from "./ReviewDiscussion";
import { FeedbackLink } from "./FeedbackLink";
import { Sources } from "./Sources";
import s from "@/components/missionCards/mission-card.module.css";
import r from "./monthly-review.module.css";

type Drafts = Partial<Record<TMonthlyReviewField, string>>;
const NO_CARDS: Card[] = [];

function tone(status: TMonthlyReviewItemPayload["status"]): "wait" | "warn" | "done" | undefined {
  if (status === "confirmed") return "done";
  if (status === "returned" || status === "draft_failed") return "warn";
  if (status === "submitted" || status === "drafting") return "wait";
  return undefined;
}

export function ReviewItemScreen({ initialItem }: { initialItem: TMonthlyReviewItemPayload }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [item, setItem] = useState(initialItem);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [returning, setReturning] = useState<string | null>(null);
  const inFlight = useRef(false);
  const { ask, dialog } = useConfirm();

  const month = monthOf(item.period);
  const kind = item.subjectType === "battlefield" ? "战场" : "能力域";
  const title = `${item.subjectCode ? `${item.subjectCode} ` : ""}${item.subjectName} · ${month} 月复盘`;
  const { isOwner, isCeo, isParticipant } = item.viewer;
  const action = useCallback((type: string): ReviewAction | undefined => item.actions.find((candidate) => candidate.actionType === type), [item.actions]);
  const editable = Boolean(action("monthly-review-item.update"));
  const dirtyFields = FIELDS.filter((field) => drafts[field] !== undefined && drafts[field] !== (item.selfReview?.[field].text ?? ""));

  useRegisterDetail(useMemo(() => ({ scope: item.conversationScope, label: title, mark: "review" as const, cards: NO_CARDS }), [item.conversationScope, title]));

  const accept = useCallback((next: TMonthlyReviewItemPayload) => setItem((current) => next.version < current.version ? current : next), []);
  const refresh = useCallback(async () => {
    try {
      const { data, response } = await browserApi.GET("/api/monthly-review-items/{itemId}", { params: { path: { itemId: item.itemId } } });
      if (response.status === 401) { router.push("/access"); return; }
      if (data?.item) accept(data.item);
    } catch { /* 下一次轮询或操作时再取 */ }
  }, [item.itemId, router, accept]);

  // 起草和评估在后台跑：跑的时候每 3 秒读一次；Agent 在对话里给了建议也立刻读。
  const running = item.status === "drafting" || item.assessment.status === "running" || item.assessment.status === "pending";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [running, refresh]);
  // 讨论是多人的：没确认前每 15 秒读一次，别人的补充和状态变化能及时看到。
  useEffect(() => {
    if (item.status === "confirmed" || running) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [item.status, running, refresh]);
  useEffect(() => {
    const suggested = (event: Event) => { if ((event as CustomEvent<{ scope: string }>).detail?.scope === item.conversationScope) void refresh(); };
    window.addEventListener("monthly-review-suggested", suggested);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("monthly-review-suggested", suggested); window.removeEventListener("focus", refresh); };
  }, [item.conversationScope, refresh]);

  const perform = async (descriptor: ReviewAction | undefined, input?: unknown, done?: string) => {
    if (!descriptor || inFlight.current) return false;
    inFlight.current = true;
    setPending(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const result = await runReviewAction(descriptor, input);
      if (result.item) accept(result.item);
      if (done) setNotice(done);
      router.refresh();
      return true;
    } catch (cause) {
      setError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。"));
      if (cause instanceof ReviewActionError) {
        if (cause.fieldErrors) setFieldErrors(cause.fieldErrors);
        if (cause.status === 409) await refresh();
      }
      return false;
    } finally { inFlight.current = false; setPending(false); }
  };

  const save = async (then?: string) => {
    if (!dirtyFields.length) return true;
    const ok = await perform(action("monthly-review-item.update"), { fields: dirtyFields.map((field) => ({ field, text: drafts[field] ?? "" })) }, then);
    if (ok) setDrafts({});
    return ok;
  };
  const submit = async () => {
    if (dirtyFields.length && !(await save())) return;
    // 保存后 actions 换了新版本：从最新的 item 里取提交动作。
    const latest = await browserApi.GET("/api/monthly-review-items/{itemId}", { params: { path: { itemId: item.itemId } } }).then(({ data }) => data?.item).catch(() => undefined);
    const current = latest ?? item;
    if (latest) accept(latest);
    await perform(current.actions.find((candidate) => candidate.actionType === "monthly-review-item.submit"), undefined, "已提交");
  };
  const resolve = async (field: TMonthlyReviewField, decision: "adopt" | "dismiss") => {
    if (decision === "adopt" && drafts[field] !== undefined && drafts[field] !== item.selfReview?.[field].text && !(await ask(`「${FIELD_LABELS[field]}」有还没保存的改动，采用建议会替换掉它们。`, "采用建议"))) return;
    void perform(action("monthly-review-item.resolve_suggestion"), { field, decision }, decision === "adopt" ? `已采用「${FIELD_LABELS[field]}」的改写。` : "").then((ok) => {
      if (ok) setDrafts((current) => { const next = { ...current }; delete next[field]; return next; });
    });
  };

  // CEO 自己负责的项（含待指派代复盘）：提交后由自己确认，状态按 CEO 的口吻写。
  const status = itemStatusText(item, isOwner && !(isCeo && item.status === "submitted"));
  const suggestionFor = (field: TMonthlyReviewField) => item.suggestions.find((suggestion) => suggestion.field === field);
  const retryDraft = action("monthly-review-item.retry_draft");
  const confirm = action("monthly-review-item.confirm");
  const giveBack = action("monthly-review-item.return");
  const retryAssessment = action("monthly-review-item.retry_assessment");
  const submitAction = action("monthly-review-item.submit");

  return <div className={s.screen}>
    <DetailFrame title={title} subtitle={`${kind}月度复盘 · 负责人 ${item.ownerName}${item.ownerUnassigned ? "（待指派）" : ""}${isParticipant && !isOwner ? " · 你参与讨论" : ""}`} onBack={() => workspace.close()}
      actions={<span className={r.chip} data-tone={tone(item.status)}>{status}</span>}>
      <div className={s.content}>
        <div className={s.document}>
          {(item.status === "returned" && item.returnReason) || error || notice ? <div className={r.messages}>
            {item.status === "returned" && item.returnReason ? <p className={s.error} role="note">CEO 打回：{item.returnReason}</p> : null}
            {error ? <p className={s.error} role="alert">{error}</p> : null}
            {notice ? <p className={s.notice} role="status">{notice}</p> : null}
          </div> : null}

          <section className={r.goal} aria-label="本月目标">
            <h2>{item.subjectType === "battlefield" ? "战场 · " : ""}{month} 月目标</h2>
            {item.target ? <p>{item.target}</p> : <p className={r.muted}>{month} 月没有签发的目标</p>}
            <h2>{item.subjectType === "battlefield" ? "战场 · " : ""}六个月目标</h2>
            <p className={r.muted}>{item.sixMonthOutcome || "未填写"}</p>
          </section>

          {item.status === "waiting" ? <p className={r.muted} role="status">等待个人复盘交齐</p> : null}
          {item.status === "drafting" ? <div className={r.working} role="status"><span className={r.pulse} aria-hidden />Co-Agent 正在起草自评…</div> : null}
          {item.status === "draft_failed" ? <div className={s.error} role="alert">
            起草没有成功{item.draftError ? `：${item.draftError.message}` : ""}。
            {retryDraft ? <div className={s.inlineActions} style={{ marginTop: 8 }}><Button variant="primary" className={s.primary} isDisabled={pending} onPress={() => void perform(retryDraft, undefined, "已重新开始起草。")}>重新起草</Button></div> : null}
          </div> : null}

          {item.selfReview ? <dl className={s.fields} aria-label="自评">
            {FIELDS.map((field) => {
              const saved = item.selfReview![field];
              const suggestion = suggestionFor(field);
              const value = drafts[field] ?? saved.text;
              return <div key={field} className={s.field} data-changed={drafts[field] !== undefined && drafts[field] !== saved.text ? "" : undefined}>
                <dt><label htmlFor={`review-${field}`}>{FIELD_LABELS[field]}</label></dt>
                <dd>
                  {editable
                    ? <textarea id={`review-${field}`} className={r.editor} value={value} rows={Math.min(14, Math.max(3, value.split("\n").length + Math.ceil(value.length / 48)))} maxLength={4000} disabled={pending}
                        data-dirty={drafts[field] !== undefined && drafts[field] !== saved.text ? "" : undefined}
                        aria-invalid={fieldErrors[field] ? true : undefined} aria-describedby={fieldErrors[field] ? `review-${field}-error` : undefined}
                        placeholder={FIELD_HINTS[field]} onChange={(event) => setDrafts((current) => ({ ...current, [field]: event.target.value }))} />
                    : <p id={`review-${field}`}>{saved.text || <span className={s.missing}>{OPTIONAL_FIELDS.includes(field) ? "无" : "未填写"}</span>}</p>}
                  {fieldErrors[field] ? <p id={`review-${field}-error`} className={s.proposalError}>这一栏还没写，提交前要写上</p> : null}
                  <Sources sources={saved.sources} />
                  {suggestion && isOwner && editable ? <div className={r.suggestion} role="group" aria-label={`${FIELD_LABELS[field]}的改写建议`}>
                    <header>Agent 建议改写 · {monthDayTime(suggestion.createdAt)}</header>
                    <p>{suggestion.text}</p>
                    {suggestion.rationale ? <small>{suggestion.rationale}</small> : null}
                    <div className={s.inlineActions}>
                      <Button variant="primary" className={s.decisionPrimary} isDisabled={pending} onPress={() => void resolve(field, "adopt")}>采用</Button>
                      <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void resolve(field, "dismiss")}>忽略</Button>
                    </div>
                  </div> : null}
                </dd>
              </div>;
            })}
          </dl> : null}

          {editable ? <div className={r.bar}>
            {dirtyFields.length ? <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void save("已保存。")}>保存</Button> : null}
            {submitAction ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={() => void submit()}>{pending ? "正在提交…" : item.status === "returned" ? "重新提交" : "提交复盘"}</Button> : null}
          </div> : null}

          <ReviewDiscussion itemId={item.itemId} comments={item.comments} participantNames={item.participantNames} canComment={item.viewer.canComment} viewerId={workspace.viewerId}
            onPosted={(comment) => setItem((current) => current.comments.some((existing) => existing.id === comment.id) ? current : { ...current, comments: [...current.comments, comment] })} />

          {item.assessment.status !== "none" ? <section className={r.section} aria-label="Co-Agent 偏差评估">
            <h2>Co-Agent 偏差评估</h2>
            {item.assessment.status === "running" || item.assessment.status === "pending"
              ? <div className={r.working} role="status"><span className={r.pulse} aria-hidden />Co-Agent 正在评估…</div>
              : item.assessment.status === "failed"
                ? <div className={s.error} role="alert">评估没有成功{item.assessment.error ? `：${item.assessment.error.message}` : ""}
                    {retryAssessment ? <div className={s.inlineActions} style={{ marginTop: 8 }}><Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void perform(retryAssessment, undefined, "已重新开始评估。")}>重新评估</Button></div> : null}
                  </div>
                : item.assessment.result ? <div className={r.assessment}>
                    <p className={r.overall}>{item.assessment.result.overall}</p>
                    {item.assessment.result.deviations.length ? <><h3>偏差</h3><ul>{item.assessment.result.deviations.map((deviation, index) => <li key={index}>{deviation.point}<span className={r.evidence}>依据：{deviation.evidence}</span></li>)}</ul></> : <p>没有发现明显偏差。</p>}
                    {item.assessment.result.questions.length ? <><h3>{isCeo ? "可以追问" : "CEO 可能会问"}</h3><ul>{item.assessment.result.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></> : null}
                  </div> : null}
          </section> : null}

          {confirm || giveBack ? <div className={r.bar}>
            {returning !== null ? <div className={r.returnBox}>
              <label htmlFor="review-return">打回原因</label>
              <textarea id="review-return" value={returning} maxLength={500} autoFocus onChange={(event) => setReturning(event.target.value)} placeholder="例如：差距没有对照目标写清楚" />
              <div className={s.inlineActions}>
                <Button variant="primary" className={s.decisionPrimary} isDisabled={pending || !returning.trim()} onPress={() => void perform(giveBack, { reason: returning.trim() }, "已打回").then((ok) => { if (ok) setReturning(null); })}>打回</Button>
                <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => setReturning(null)}>取消</Button>
              </div>
            </div> : <>
              {confirm ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={() => void perform(confirm, undefined, "已确认这项复盘。")}>确认</Button> : null}
              {giveBack ? <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => setReturning("")}>打回</Button> : null}
              {isCeo ? <Button variant="ghost" className={s.secondary} onPress={() => workspace.navigate(`/reviews/${item.period}`)}>回到 {month} 月复盘总览</Button> : null}
            </>}
          </div> : null}

          {item.history.length ? <section className={r.section} aria-label="记录">
            <h2>记录</h2>
            <ol className={r.history}>
              {item.history.map((entry, index) => <li key={index}><time dateTime={entry.at}>{monthDayTime(entry.at)}</time>{entry.byName}{entry.action === "submit" ? "提交了复盘" : entry.action === "confirm" ? "确认了复盘" : `打回：${entry.reason ?? ""}`}</li>)}
            </ol>
          </section> : null}
          <FeedbackLink />
        </div>
      </div>
    </DetailFrame>
    {dialog}
  </div>;
}

