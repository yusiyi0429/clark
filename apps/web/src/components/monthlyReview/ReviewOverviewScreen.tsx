"use client";

/**
 * CEO 月末复盘总览（spec §6.2）：看到战场 / 能力域一层，逐项确认或打回；全部确认后确认公司复盘（四部分：总体结果、关键经营判断、下周期经营重点、长期目标修订建议），
 * 再去单独的一页审视 LTO（公司与各战场）。当月还没有复盘时可以手动提前开启。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "ts-design/primitives";
import type { TMonthlyReviewItemRow, TMonthlyReviewJudgment, TMonthlyReviewResponse } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { FeedbackLink } from "./FeedbackLink";
import { itemStatusText, monthOf, requestError, runReviewAction, ReviewActionError, type ReviewAction } from "./reviewApi";
import s from "@/components/missionCards/mission-card.module.css";
import r from "./monthly-review.module.css";

const NO_CARDS: Card[] = [];
type SummaryDraft = { overall: string; judgments: TMonthlyReviewJudgment[]; focusText: string };
const focusLines = (text: string) => text.split("\n").map((line) => line.replace(/^\s*(\d+[.、)]|[-•·])\s*/, "").trim()).filter(Boolean);
const rowTone = (row: TMonthlyReviewItemRow) => row.status === "confirmed" ? "done" : row.status === "submitted" ? "wait" : row.status === "returned" || row.status === "draft_failed" ? "warn" : undefined;

export function ReviewOverviewScreen({ initial }: { initial: TMonthlyReviewResponse }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [returning, setReturning] = useState<{ itemId: string; reason: string } | null>(null);
  const [summaryDraft, setSummaryDraft] = useState<SummaryDraft | null>(null);
  const inFlight = useRef(false);
  const review = view.review;
  const month = monthOf(view.period);
  const title = `${month} 月复盘`;

  // 总览没有自己的对象对话：右列就是 CEO 的全局 Agent。
  useRegisterDetail(useMemo(() => ({ scope: "global", label: title, mark: "monthly" as const, cards: NO_CARDS }), [title]));

  const refresh = useCallback(async () => {
    try {
      const { data, response } = await browserApi.GET("/api/monthly-reviews/{period}", { params: { path: { period: view.period } } });
      if (response.status === 401) { router.push("/access"); return; }
      if (data) setView((current) => current.review && data.review && data.review.version < current.review.version ? current : data);
    } catch { /* 下次再取 */ }
  }, [view.period, router]);

  const running = Boolean(review && (review.summary.status === "running" || review.summary.status === "pending"
    || review.items.some((row) => row.status === "drafting" || row.assessmentStatus === "running" || row.assessmentStatus === "pending")));
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, running ? 3_000 : 20_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("monthly-review-changed", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("monthly-review-changed", refresh); };
  }, [running, refresh]);

  const perform = async (descriptor: ReviewAction | undefined, input?: unknown, done?: string) => {
    if (!descriptor || inFlight.current) return false;
    inFlight.current = true;
    setPending(true); setError(""); setNotice("");
    try {
      const result = await runReviewAction(descriptor, input);
      if (result.review) setView((current) => ({ ...current, review: result.review!, actions: [] }));
      else await refresh();
      if (done) setNotice(done);
      router.refresh();
      return true;
    } catch (cause) {
      setError(requestError(cause, "暂时无法连接服务器，请稍后重试。"));
      if (cause instanceof ReviewActionError && cause.status === 409) await refresh();
      return false;
    } finally { inFlight.current = false; setPending(false); }
  };

  const open = view.actions.find((candidate) => candidate.actionType === "monthly-review.open");
  const reviewAction = (type: string) => review?.actions.find((candidate) => candidate.actionType === type);
  const itemHref = (itemId: string) => `/reviews/items/${itemId}`;

  if (!review) return <div className={s.screen}>
    <DetailFrame title={title} subtitle="月末复盘" onBack={() => workspace.close()}>
      <div className={s.content}><div className={s.document}>
        {error ? <p className={s.error} role="alert">{error}</p> : null}
        <p className={`${s.readonly} ${s.readonly}`}>{month} 月复盘还没有开始。月底倒数第 3 天会自动开启；也可以现在开始：每个战场和能力域会各有一项复盘，由负责人的 Agent 先起草，负责人修改后提交给你确认。</p>
        {open ? <Button variant="primary" className={s.primary} isDisabled={pending} onPress={() => void perform(open, undefined, "复盘已开启，Co-Agent 正在为每个负责人起草自评。")}>{pending ? "正在开启…" : `开始 ${month} 月复盘`}</Button> : null}
      </div></div>
    </DetailFrame>
  </div>;

  const groups = [
    { key: "battlefield", title: "战场", rows: review.items.filter((row) => row.subjectType === "battlefield") },
    { key: "capability", title: "能力域", rows: review.items.filter((row) => row.subjectType === "capability") },
  ].filter((group) => group.rows.length);
  const saved: SummaryDraft = { overall: review.summary.overall, judgments: review.summary.judgments, focusText: review.summary.nextFocus.join("\n") };
  const editing = summaryDraft ?? saved;
  const summaryDirty = summaryDraft !== null && JSON.stringify(summaryDraft) !== JSON.stringify(saved);
  const summaryInput = { overall: editing.overall.trim(), judgments: editing.judgments.map((item) => ({ title: item.title.trim(), body: item.body.trim() })), nextFocus: focusLines(editing.focusText).slice(0, 8) };
  const summaryInvalid = !summaryInput.overall || !summaryInput.judgments.length || summaryInput.judgments.some((item) => !item.title || !item.body) || !summaryInput.nextFocus.length;
  const patchSummary = (patch: Partial<SummaryDraft>) => setSummaryDraft({ ...editing, ...patch });
  const updateSummary = reviewAction("monthly-review.update_summary");
  const confirmSummary = reviewAction("monthly-review.confirm_summary");
  const retrySummary = reviewAction("monthly-review.retry_summary");
  const statusText = review.status === "collecting" ? `${review.counts.confirmed}/${review.counts.total} 项已确认`
    : review.status === "summarizing" ? "各项已确认 · 待确认公司复盘" : review.status === "ltco_pending" ? "公司复盘已确认 · 待审视长期目标" : "已完成";

  const confirmCompany = async () => {
    if (summaryDirty && !(await perform(updateSummary, summaryInput))) return;
    // 保存后版本变了：重新读取，再用最新的确认动作。
    const { data } = await browserApi.GET("/api/monthly-reviews/{period}", { params: { path: { period: view.period } } });
    const latest = data?.review?.actions.find((candidate) => candidate.actionType === "monthly-review.confirm_summary") ?? confirmSummary;
    if (await perform(latest, undefined, "公司复盘已确认。下一步审视公司长期目标。")) setSummaryDraft(null);
  };

  return <div className={s.screen}>
    <DetailFrame title={title} subtitle="月末复盘 · 先复盘，再拆解" onBack={() => workspace.close()}
      actions={<span className={r.chip} data-tone={review.status === "closed" ? "done" : "wait"}>{statusText}</span>}>
      <div className={s.content}><div className={s.document}>
        {error || notice ? <div className={r.messages}>
          {error ? <p className={s.error} role="alert">{error}</p> : null}
          {notice ? <p className={s.notice} role="status">{notice}</p> : null}
        </div> : null}
        <p className={r.progress}>
          <span>共 <strong>{review.counts.total}</strong> 项</span>
          <span>已提交 <strong>{review.counts.submitted}</strong></span>
          <span>已确认 <strong>{review.counts.confirmed}</strong></span>
          {review.counts.returned ? <span>打回修改中 <strong>{review.counts.returned}</strong></span> : null}
        </p>

        {groups.map((group) => <section key={group.key} className={r.group} aria-label={group.title}>
          <h2>{group.title}</h2>
          <ul className={r.rows}>
            {group.rows.map((row) => {
              const confirm = row.actions.find((candidate) => candidate.actionType === "monthly-review-item.confirm");
              const giveBack = row.actions.find((candidate) => candidate.actionType === "monthly-review-item.return");
              return <li key={row.itemId} className={r.row}>
                <Button variant="ghost" className={r.rowMain} onPress={() => workspace.navigate(itemHref(row.itemId))} aria-label={`打开 ${row.subjectName} 的复盘`}>
                  <span className={r.rowTitle}>{row.subjectCode ? `${row.subjectCode} ` : ""}{row.subjectName}<span className={r.chip} data-tone={rowTone(row)}>{itemStatusText(row, false)}</span><span className={r.rowOwner}>{row.ownerName}{row.ownerUnassigned ? " · 待指派" : ""}</span></span>
                  {row.lead ? <span className={r.rowLead}>{row.lead}</span> : null}
                  {row.assessmentStatus === "ready" && row.assessmentOverall ? <span className={r.rowAssess}>Co-Agent：{row.assessmentOverall}{row.deviationCount ? ` · ${row.deviationCount} 处偏差` : ""}</span>
                    : row.assessmentStatus === "running" || row.assessmentStatus === "pending" ? <span className={r.rowAssess}>Co-Agent 正在评估…</span>
                    : row.assessmentStatus === "failed" ? <span className={r.rowAssess}>评估没有成功，可以打开重试</span> : null}
                </Button>
                {confirm || giveBack ? <span className={r.rowActions}>
                  {confirm ? <Button variant="primary" className={s.decisionPrimary} isDisabled={pending} onPress={() => void perform(confirm, undefined, `已确认 ${row.subjectName}。`)}>确认</Button> : null}
                  {giveBack ? <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => setReturning({ itemId: row.itemId, reason: "" })}>打回</Button> : null}
                </span> : null}
                {returning?.itemId === row.itemId && giveBack ? <div className={`${r.returnBox} ${r.rowReturn}`}>
                  <label htmlFor={`return-${row.itemId}`}>打回原因（负责人会看到）</label>
                  <textarea id={`return-${row.itemId}`} value={returning.reason} maxLength={500} autoFocus onChange={(event) => setReturning({ itemId: row.itemId, reason: event.target.value })} />
                  <div className={s.inlineActions}>
                    <Button variant="primary" className={s.decisionPrimary} isDisabled={pending || !returning.reason.trim()} onPress={() => void perform(giveBack, { reason: returning.reason.trim() }, `已打回 ${row.subjectName}。`).then((ok) => { if (ok) setReturning(null); })}>打回</Button>
                    <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => setReturning(null)}>取消</Button>
                  </div>
                </div> : null}
              </li>;
            })}
          </ul>
        </section>)}

        {review.status !== "collecting" ? <section className={r.section} aria-label="公司月度复盘">
          <h2>公司月度复盘</h2>
          {review.summary.status === "running" || review.summary.status === "pending"
            ? <div className={r.working} role="status"><span className={r.pulse} aria-hidden />Co-Agent 正在汇总各项复盘…</div>
            : review.summary.status === "failed"
              ? <div className={s.error} role="alert">汇总没有成功{review.summary.error ? `：${review.summary.error.message}` : ""}。
                  {retrySummary ? <div className={s.inlineActions} style={{ marginTop: 8 }}><Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void perform(retrySummary, undefined, "已重新开始汇总。")}>重新汇总</Button></div> : null}
                </div>
              : <div className={r.summary}>
                  <h3>本周期总体结果</h3>
                  {updateSummary
                    ? <textarea className={r.editor} aria-label="本周期总体结果" value={editing.overall} maxLength={3000} rows={4} disabled={pending} onChange={(event) => patchSummary({ overall: event.target.value })} />
                    : <p>{review.summary.overall}</p>}
                  <h3>关键经营判断</h3>
                  <ol className={r.judgments}>
                    {editing.judgments.map((judgment, index) => <li key={index} className={r.judgment}>
                      {updateSummary ? <>
                        <input aria-label={`第 ${index + 1} 条判断的标题`} value={judgment.title} maxLength={60} disabled={pending} onChange={(event) => patchSummary({ judgments: editing.judgments.map((item, at) => at === index ? { ...item, title: event.target.value } : item) })} />
                        <textarea aria-label={`第 ${index + 1} 条判断`} value={judgment.body} maxLength={1500} disabled={pending} onChange={(event) => patchSummary({ judgments: editing.judgments.map((item, at) => at === index ? { ...item, body: event.target.value } : item) })} />
                        {editing.judgments.length > 1 ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => patchSummary({ judgments: editing.judgments.filter((_, at) => at !== index) })}>删掉这条</Button> : null}
                      </> : <><span className={r.judgmentTitle}>{judgment.title}</span><p>{judgment.body}</p></>}
                    </li>)}
                  </ol>
                  {updateSummary && editing.judgments.length < 8 ? <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => patchSummary({ judgments: [...editing.judgments, { title: "", body: "" }] })}>加一条判断</Button> : null}
                  <h3>下周期经营重点</h3>
                  {updateSummary
                    ? <textarea className={r.editor} aria-label="下周期经营重点（每行一条）" value={editing.focusText} rows={4} disabled={pending} placeholder="每行一条，最多 8 条" onChange={(event) => patchSummary({ focusText: event.target.value })} />
                    : <ol className={r.focusList}>{review.summary.nextFocus.map((line, index) => <li key={index}>{line}</li>)}</ol>}
                  <h3>长期目标修订建议</h3>
                  {review.ltco.suggestion
                    ? <p>{review.ltco.suggestion.change || review.ltco.suggestion.units.length
                        ? `建议修订${review.ltco.suggestion.change ? "公司长期目标" : ""}${review.ltco.suggestion.change && review.ltco.suggestion.units.length ? "和" : ""}${review.ltco.suggestion.units.length ? ` ${review.ltco.suggestion.units.length} 个战场长期目标` : ""}。`
                        : "建议保持。"}{review.ltco.suggestion.rationale}<span className={s.hint}>（确认公司复盘后，在长期目标审视里逐条决定）</span></p>
                    : <p className={s.hint}>汇总完成后给出。</p>}
                  <div className={r.bar}>
                    {confirmSummary ? <Button variant="primary" className={s.primary} isDisabled={pending || summaryInvalid} onPress={() => void confirmCompany()}>确认公司复盘</Button> : null}
                    {summaryDirty ? <Button variant="ghost" className={s.secondary} isDisabled={pending || summaryInvalid} onPress={() => void perform(updateSummary, summaryInput, "已保存。").then((ok) => { if (ok) setSummaryDraft(null); })}>保存</Button> : null}
                    {retrySummary && review.summary.status === "ready" ? <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void perform(retrySummary, undefined, "已重新开始汇总。")}>重新汇总</Button> : null}
                    {review.summary.confirmedAt ? <p className={s.hint}>{monthDayTime(review.summary.confirmedAt)} 已确认</p> : null}
                  </div>
                </div>}
        </section> : null}

        {review.status === "ltco_pending" ? <div className={r.bar}>
          <Button variant="primary" className={s.primary} onPress={() => workspace.navigate(`/reviews/${review.period}/ltco`)}>审视公司长期目标</Button>
        </div> : null}
        {review.status === "closed" && review.ltco.decision ? <section className={r.section} aria-label="长期目标审视">
          <h2>长期目标审视</h2>
          <p className={s.hint}>{monthDayTime(review.ltco.decision.decidedAt)} {review.ltco.decision.decision === "keep" ? "决定保持不变" : `已修订${review.ltco.decision.ltcoAfter !== review.ltco.decision.ltcoBefore ? "公司长期目标" : ""}${review.ltco.decision.units.length ? `${review.ltco.decision.ltcoAfter !== review.ltco.decision.ltcoBefore ? "和" : ""} ${review.ltco.decision.units.length} 个战场长期目标` : ""}`}。{monthOf(review.nextPeriod)} 月计划草案{review.ltco.decision.planExisted ? "之前已经有了，可以在计划页重新生成" : "已开始生成"}。</p>
          <div className={r.bar}><Button variant="primary" className={s.primary} onPress={() => workspace.navigate(`/plans/${review.nextPeriod}`)}>查看 {monthOf(review.nextPeriod)} 月计划</Button></div>
        </section> : null}
        <FeedbackLink />
      </div></div>
    </DetailFrame>
  </div>;
}
