"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { Check, RotateCcw } from "lucide-react";
import type { Card, CardAction } from "@/lib/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { calendarDate, monthDayTime } from "@/lib/companyTime";
import { useCardAction, type ActionState } from "@/lib/useCardAction";
import { payloadOf, type IssuePayload } from "@/cards/payloads";
import { RadarOriginTag } from "@/components/OriginTag";
import {
  ISSUE_STATUS_LABEL,
  decisionOptions,
  decisionRequest,
  defaultDecisionText,
  type DecisionDraft,
  type DecisionOption,
  type OutcomeItem,
  type PreflightEntry,
} from "@/cards/meetingIssueModel";
import { issueAnchorId, sectionAnchorId } from "@/cards/meetingSources";
import { DecisionHistoryLayers, type HistoryView } from "./DecisionHistoryLayers";
import { SourceChip, SourceList } from "./SourceViewer";
import { LensAnswers } from "./PreflightReviewExtras";
import { DECISION_HISTORY_CHANGED } from "./useDecisionHistory";
import s from "@/styles/meeting-workspace.module.css";
import { cleanDisplayText, shortSourceName } from "@/lib/displayText";
import { StructuredText } from "@/components/StructuredText";

/**
 * 会议页里的一个议题块（feedback 15 / H06）：首屏是这个议题的核心判断，往下依次是历史与变化、事实与依据、
 * 选项与后果、建议、你的决定、实际结果。决定走原生 issue.decide / decide_override（预研未完成时须二次确认），
 * 撤回走 issue.revoke_receipt；页面只按服务端返回的议题 Card 显示「已决定」和回执，从不在本地假装成功。
 * 会后（会议记录）用 focus="outcome"：先列这个议题的会后条目和原生确认 / 忽略，再是结果与历史。
 */

const RESEARCH_TEXT: Record<string, string> = {
  pending: "预研排队中，尚无判断。",
  running: "预研进行中，尚无判断。",
  failed: "预研失败，尚无判断。",
};

const ANALYSIS_LABEL: Record<string, string> = {
  strategic_alignment: "战略一致性判断",
  positive_signal: "积极信号",
  risk_calibration: "潜在风险 & 待校准问题",
  legacy: "预审条目",
};

export type IssueBlockProps = {
  issueId: string;
  index: number;
  total: number;
  /** 议题 Card（带原生决定 Action）；没载入时只显示历史里的标题。 */
  card: Card | null;
  history: HistoryView;
  /** 归到这个议题的预审条目（已套用会前草稿改写）。 */
  entries: PreflightEntry[];
  /** 单议题会议：预审的「最关键问题 / 最优先动作」也属于它。 */
  summary?: { priorityAction: string; criticalIssue: string } | null;
  outcomeItems: OutcomeItem[];
  renderOutcomeItem: (item: OutcomeItem) => ReactNode;
  focus: "decision" | "outcome";
  /** 这里允许 CEO 使用的原生议题 Action（演示：决定 / 预研未完成时决定 / 撤回）。空数组 = 只读。 */
  decisionActions: CardAction[];
  scopeLabel: string;
  currentMeetingId: string;
  /** 目录里的章节 key。 */
  outlineKey: string;
  onCard: (card: Card) => void;
  onOpenIssue: (origin?: Element | null) => void;
  /** 会后视图里「看依据与选项」：切回议题工作区并定位到这个议题。 */
  onShowDecision?: () => void;
  /** 正式版会前准备：已阅 / 带到会议。 */
  prep?: ReactNode;
  /** 正式版每条预审条目下的「标记已核对 / 请求补充材料」。 */
  entryExtra?: (entry: PreflightEntry) => ReactNode;
  checkedEntryIds?: string[];
};

/** 决定、撤回成功后：首页和关联页重读服务端投影（演示），历史分层跟着重读。 */
function announceDecision(issueId: string, actionType: string) {
  window.dispatchEvent(new CustomEvent(DECISION_HISTORY_CHANGED, { detail: { issueId } }));
}

export function IssueDecisionBlock(props: IssueBlockProps) {
  const { issueId, index, total, card, history, entries, summary, outcomeItems, renderOutcomeItem, focus, decisionActions, scopeLabel,
    currentMeetingId, outlineKey, onCard, onOpenIssue, onShowDecision, prep, entryExtra, checkedEntryIds = [] } = props;
  const payload = card ? payloadOf<IssuePayload>(card) : null;
  const titleId = useId();
  const title = card?.title ?? history.data?.issueTitle ?? "关联议题";
  const status = payload?.status ?? history.data?.issueStatus ?? "pending";
  const doc = payload?.research.status === "ready" ? payload.research.doc : undefined;
  const deadline = status === "pending" && payload?.urgency.decisionBy ? calendarDate(payload.urgency.decisionBy) : "";

  const core = entries.filter((entry) => entry.kind === "core_judgment");
  const questions = entries.filter((entry) => entry.kind === "meeting_question");
  const lens = entries.filter((entry) => entry.kind === "leader_lens");
  const advice = entries.filter((entry) => entry.kind === "next_step");
  const analysis = entries.filter((entry) => !["core_judgment", "meeting_question", "leader_lens", "next_step"].includes(entry.kind));
  const options = decisionOptions(doc, questions);

  const decide = decisionActions.find((action) => action.actionType === "issue.decide");
  const override = decisionActions.find((action) => action.actionType === "issue.decide_override");
  const revokeOf = (receiptId: string) => decisionActions.find((action) => action.actionType === "issue.revoke_receipt" && action.itemId === receiptId);
  const canDecide = status === "pending" && Boolean(decide || override);

  const { ask, dialog } = useConfirm();
  const { state, run, retry, pending } = useCardAction(onCard);
  const [draft, setDraft] = useState<DecisionDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // 议题不再待决定（在对话里、别的页面决定了，或被移出）：收起没提交的表单，以服务端为准。
  useEffect(() => {
    if (status !== "pending") {
      setDraft(null);
      setFormError(null);
    }
  }, [status]);

  const choose = (option: DecisionOption | null) => {
    setFormError(null);
    setDraft(option
      ? { optionKey: option.key, optionId: decide ? option.optionId : null, text: defaultDecisionText(option), overrideConfirmed: false }
      : { optionKey: null, optionId: null, text: "", overrideConfirmed: false });
  };

  async function submit() {
    if (!draft) return;
    const request = decisionRequest({ decide, override }, draft);
    if ("error" in request) {
      setFormError(request.error);
      return;
    }
    setFormError(null);
    const updated = await run(request.action, request.input);
    if (updated) {
      setDraft(null);
      announceDecision(issueId, request.action.actionType);
    }
  }

  async function revoke(action: CardAction) {
    if (!(await ask("撤回后这条决定不再约束，议题回到待决定，原记录会保留为「已撤回」。确定撤回吗？", "撤回决定"))) return;
    const updated = await run(action, {});
    if (updated) announceDecision(issueId, "issue.revoke_receipt");
  }

  const form = (
    <DecisionForm draft={draft} override={!decide && Boolean(override)} pending={pending} error={formError}
      onChange={(next) => setDraft(next)} onCancel={() => { setDraft(null); setFormError(null); }} onSubmit={() => void submit()} />
  );

  const receipts = payload?.receipts ?? [];
  const active = receipts.filter((receipt) => !receipt.revokedAt);
  const revoked = receipts.filter((receipt) => receipt.revokedAt);
  const lastEffective = history.data?.effective.at(-1) ?? null;
  const optionLabel = (optionId?: string) => (optionId ? doc?.options.find((option) => option.id === optionId)?.label : undefined);

  const judgment = (
    <section key="judgment" className={s.issueSection} id={sectionAnchorId(issueId, "judgment")} data-outline-sub={`${outlineKey}:judgment`}>
      <h3 className={s.sectionLabel}>核心判断</h3>
      {core.length ? core.map((entry) => (
        <div key={entry.id} className={s.judgmentText} data-checked={checkedEntryIds.includes(entry.id) || undefined}>
          <strong>{entry.title}</strong>
          <p>{entry.body}</p>
          <SourceList refs={entry.sourceRefs} issueId={issueId} />
          {entryExtra?.(entry)}
        </div>
      )) : doc?.summary ? (
        <div className={s.judgmentText}>
          <strong>预研判断</strong>
          <StructuredText text={doc.summary} />
        </div>
      ) : <p className={s.empty}>{RESEARCH_TEXT[payload?.research.status ?? ""] ?? "尚无对该议题的判断。"}</p>}
      {summary?.criticalIssue ? <p className={s.keyLine}><small>最关键问题</small>{summary.criticalIssue}</p> : null}
      {questions.map((entry) => (
        <div key={entry.id} className={s.questionCard} data-checked={checkedEntryIds.includes(entry.id) || undefined}>
          <small>待一号位判断</small>
          <strong>{entry.title}</strong>
          <p>{entry.body}</p>
          {entry.ceoDecision ? (
            <div className={s.heroSummary}>
              <span><small>决策时机</small>{entry.ceoDecision.whyNow}</span>
              <span><small>需一号位决定的原因</small>{entry.ceoDecision.whyCeo}</span>
              {entry.ceoDecision.delayCost ? <span><small>延迟代价</small>{entry.ceoDecision.delayCost}</span> : null}
            </div>
          ) : null}
          <SourceList refs={entry.sourceRefs} issueId={issueId} />
          {entryExtra?.(entry)}
        </div>
      ))}
      {history.data ? (
        <p className={s.sinceLine}>
          <small>相较上次</small>
          {lastEffective ? (
            <>
              <SourceChip sourceRef={lastEffective.ref} issueId={issueId} />
              {history.data.changes.length ? `之后有 ${history.data.changes.length} 项实际变化` : "之后未获得执行证据（待补）。"}
            </>
          ) : history.data.inactive.length ? "此前的决定已撤回或被替代" : "尚无已确认的决定"}
        </p>
      ) : null}
    </section>
  );

  const historySection = (
    <section key="history" className={s.issueSection} id={sectionAnchorId(issueId, "history")} data-outline-sub={`${outlineKey}:history`}>
      <h3 className={s.sectionLabel}>历史与变化</h3>
      <DecisionHistoryLayers issueId={issueId} view={history} currentMeetingId={currentMeetingId} />
    </section>
  );

  const evidence = (
    <section key="evidence" className={s.issueSection} id={sectionAnchorId(issueId, "evidence")} data-outline-sub={`${outlineKey}:evidence`}>
      <h3 className={s.sectionLabel}>事实与依据</h3>
      {doc?.evidence.length ? (
        <ol className={s.evidenceList}>
          {doc.evidence.map((item, position) => (
            <li key={`${position}-${item.quote}`}>
              <p>{cleanDisplayText(item.quote)}</p>
              <small title={item.sourceTitle !== shortSourceName(item.sourceTitle) ? item.sourceTitle : undefined}>
                {item.sourceUrl && /^https?:\/\//.test(item.sourceUrl)
                  ? <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">{shortSourceName(item.sourceTitle)}</a>
                  : shortSourceName(item.sourceTitle)}
              </small>
            </li>
          ))}
        </ol>
      ) : null}
      {analysis.map((entry) => (
        <div key={entry.id} className={s.analysisItem} data-checked={checkedEntryIds.includes(entry.id) || undefined}>
          <small>{ANALYSIS_LABEL[entry.kind] ?? "预审判断"}</small>
          <strong>{entry.title}</strong>
          <p>{entry.body}</p>
          <SourceList refs={entry.sourceRefs} issueId={issueId} />
          {entryExtra?.(entry)}
        </div>
      ))}
      {doc?.unknowns.length ? (
        <div className={s.unknowns}>
          <small>待澄清事项</small>
          {doc.unknowns.map((unknown) => <p key={unknown}>{unknown}</p>)}
        </div>
      ) : null}
      {!doc?.evidence.length && !analysis.length && !doc?.unknowns.length ? <p className={s.empty}>预研与预审尚未给出该议题的依据。</p> : null}
    </section>
  );

  const optionsSection = (
    <section key="options" className={s.issueSection} id={sectionAnchorId(issueId, "options")} data-outline-sub={`${outlineKey}:options`}>
      <h3 className={s.sectionLabel}>选项与后果</h3>
      {options.length ? (
        <ol className={s.optionList}>
          {options.map((option, position) => (
            <li key={option.key} className={s.optionItem} data-chosen={draft?.optionKey === option.key || undefined}>
              <div className={s.optionHead}>
                <span aria-hidden="true">{String(position + 1).padStart(2, "0")}</span>
                <strong>{option.label}</strong>
              </div>
              {option.question ? <small className={s.optionFrom}>来自问题：{option.question}</small> : null}
              <ul className={s.consequences}>
                {option.consequences.map((consequence) => <li key={consequence}>{consequence}</li>)}
              </ul>
              {canDecide && draft?.optionKey !== option.key ? (
                <button type="button" className={s.chooseButton} disabled={pending} onClick={() => choose(option)}>按此决定</button>
              ) : null}
              {draft?.optionKey === option.key ? form : null}
            </li>
          ))}
        </ol>
      ) : <p className={s.empty}>预研尚未给出备选方案。</p>}
    </section>
  );

  const adviceSection = advice.length || lens.length || summary?.priorityAction ? (
    <section key="advice" className={s.issueSection} id={sectionAnchorId(issueId, "advice")} data-outline-sub={`${outlineKey}:advice`}>
      <h3 className={s.sectionLabel}>建议<span>未确认，不是决定</span></h3>
      {summary?.priorityAction ? <p className={s.keyLine}><small>最优先动作</small>{summary.priorityAction}</p> : null}
      {advice.map((entry) => (
        <div key={entry.id} className={s.analysisItem} data-checked={checkedEntryIds.includes(entry.id) || undefined}>
          <strong>{entry.title}</strong>
          <p>{entry.body}</p>
          <SourceList refs={entry.sourceRefs} issueId={issueId} />
          {entryExtra?.(entry)}
        </div>
      ))}
      {lens.length ? (
        <div className={s.leaderLens}>
          <small>决策前需澄清的问题</small>
          <ol>{lens.map((entry) => <li key={entry.id}>{entry.body}<LensAnswers options={entry.ceoDecision?.options} /></li>)}</ol>
        </div>
      ) : null}
    </section>
  ) : null;

  const decisionSection = (
    <section key="decision" className={s.issueSection} id={sectionAnchorId(issueId, "decision")} data-outline-sub={`${outlineKey}:decision`}>
      <h3 className={s.sectionLabel}>一号位决定</h3>
      {status === "dismissed" ? (
        <p className={s.empty}>已移出决策面{payload?.dismissReason ? `：${payload.dismissReason}` : ""}。</p>
      ) : status === "decided" ? (
        active.length ? (
          <div className={s.decidedLine}>
            <Check size={15} aria-hidden="true" />
            <p>你已决定：{active.at(-1)!.decisionText}</p>
          </div>
        ) : <p className={s.empty}>议题已决定。</p>
      ) : canDecide ? (
        <>
          {draft && draft.optionKey === null ? form : (
            <button type="button" className={s.chooseButton} disabled={pending} onClick={() => choose(null)}>
              {decide ? "自拟决定内容" : "直接填写决定"}
            </button>
          )}
        </>
      ) : !card ? (
        <p className={s.empty}>议题信息读取失败，请刷新页面后查看。</p>
      ) : decisionActions.length || payload?.research.status === "running" ? (
        <p className={s.empty}>{payload?.research.status === "running" ? "预研进行中" : "当前无法在此决定。"}</p>
      ) : <p className={s.empty}>尚未决定</p>}
      <DecisionFeedback state={state} onRetry={retry} />
    </section>
  );

  const resultSection = (
    <section key="result" className={s.issueSection} id={sectionAnchorId(issueId, "result")} data-outline-sub={`${outlineKey}:result`}>
      <h3 className={s.sectionLabel}>实际结果</h3>
      <p className={s.resultStatus}>
        议题状态：<b data-state={status}>{ISSUE_STATUS_LABEL[status]}</b>
        {active.length ? ` · ${active.length} 条有效决定` : ""}{revoked.length ? ` · ${revoked.length} 条已撤回` : ""}
      </p>
      {receipts.length ? (
        <ol className={s.receiptList}>
          {[...active, ...revoked].map((receipt) => {
            const revokeAction = receipt.revokedAt ? undefined : revokeOf(receipt.id);
            const option = optionLabel(receipt.optionId);
            const source = (receipt as { source?: { kind: string; meetingId: string } }).source;
            return (
              <li key={receipt.id} className={s.receipt} data-revoked={receipt.revokedAt ? "true" : undefined}>
                <div>
                  <p>{receipt.revokedAt ? <del>{receipt.decisionText}</del> : receipt.decisionText}</p>
                  <small>
                    {[receipt.revokedAt ? `已撤回 · ${monthDayTime(receipt.revokedAt)}${receipt.revokeReason ? `：${receipt.revokeReason}` : ""}` : "已写入决定回执",
                      `决定于 ${monthDayTime(receipt.createdAt)}`,
                      source?.kind === "meeting-item" ? (source.meetingId === currentMeetingId ? "该会议会后确认" : "会后确认") : receipt.override ? "预研未完成时决定" : "直接决定",
                      option ? `选项「${option}」` : null].filter(Boolean).join(" · ")}
                  </small>
                </div>
                {revokeAction ? (
                  <button type="button" className={s.revokeButton} disabled={pending} onClick={() => void revoke(revokeAction)}>
                    <RotateCcw size={13} aria-hidden="true" />
                    撤回这个决定
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : <p className={s.empty}>尚未写入决定。</p>}
      {focus === "decision" && outcomeItems.length ? (
        <div className={s.outcomeGroup}>
          <small>这场会的会后条目</small>
          {outcomeItems.map((item) => renderOutcomeItem(item))}
        </div>
      ) : null}
    </section>
  );

  const outcomeSection = focus === "outcome" ? (
    <section key="outcome" className={s.issueSection} id={sectionAnchorId(issueId, "outcome")} data-outline-sub={`${outlineKey}:outcome`}>
      <h3 className={s.sectionLabel}>会上形成的结论<span>{outcomeItems.length ? `${outcomeItems.length} 条` : ""}</span></h3>
      {outcomeItems.length ? outcomeItems.map((item) => renderOutcomeItem(item)) : <p className={s.empty}>该会议未抽取到本议题的结论。</p>}
    </section>
  ) : null;

  const sections = focus === "outcome"
    ? [outcomeSection, resultSection, historySection]
    : [judgment, historySection, evidence, optionsSection, adviceSection, decisionSection, resultSection];

  return (
    <article className={s.issueBlock} id={issueAnchorId(issueId)} data-outline={outlineKey} data-status={status} aria-labelledby={titleId}>
      {dialog}
      <header className={s.issueHead}>
        <p className={s.issueEyebrow}>
          {[`议题 ${index}${total > 1 ? ` / ${total}` : ""}`, scopeLabel, deadline ? `决定期限 ${deadline}` : ""].filter(Boolean).join(" · ")}
        </p>
        <h2 id={titleId}>{title}<RadarOriginTag issue={card ? payloadOf<IssuePayload>(card) : null} /></h2>
        <div className={s.issueHeadRow}>
          <span className={s.issueState} data-state={status}>{ISSUE_STATUS_LABEL[status]}</span>
          {prep}
          <button type="button" className={s.issueLink} onClick={(event) => onOpenIssue(event.currentTarget)}>打开议题</button>
          {focus === "outcome" && onShowDecision ? <button type="button" className={s.issueLink} onClick={onShowDecision}>查看依据与选项</button> : null}
        </div>
      </header>
      {sections}
    </article>
  );
}

function DecisionForm({ draft, override, pending, error, onChange, onCancel, onSubmit }: {
  draft: DecisionDraft | null;
  override: boolean;
  pending: boolean;
  error: string | null;
  onChange: (draft: DecisionDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  if (!draft) return null;
  return (
    <div className={s.decisionForm} role="group" aria-label="确认决定">
      <label className={s.decisionField}>
        <span>决定内容</span>
        <textarea value={draft.text} rows={3} maxLength={5000} disabled={pending} placeholder="填写决定内容"
          onChange={(event) => onChange({ ...draft, text: event.target.value })} />
      </label>
      {override ? (
        <label className={s.overrideCheck}>
          <input type="checkbox" checked={draft.overrideConfirmed} disabled={pending} onChange={(event) => onChange({ ...draft, overrideConfirmed: event.target.checked })} />
          预研还没完成，我确认现在做出这个决定
        </label>
      ) : null}
      {error ? <p className={s.formError} role="alert">{error}</p> : null}
      <div className={s.formActions}>
        <button type="button" className={s.confirmDecision} disabled={pending || !draft.text.trim()} onClick={onSubmit}>
          {pending ? "保存中…" : "确认决定"}
        </button>
        <button type="button" className={s.cancelDecision} disabled={pending} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/** 服务端原话里带内部名词（Action、Card…）时不直接给 CEO 看。 */
const plainReason = (message: string) => (/[A-Za-z]{3,}/.test(message) ? "服务暂未受理本次提交" : message);

/** 失败可重试（同一 Action、同一内容，服务端按指纹去重，不会写两条）；冲突时页面已换成最新议题，请核对后再操作。 */
function DecisionFeedback({ state, onRetry }: { state: ActionState; onRetry: () => void }) {
  if (state.status === "error") {
    return (
      <p className={s.error} role="alert">
        没有保存成功：{plainReason(state.message)}
        <button type="button" onClick={onRetry}>重试</button>
      </p>
    );
  }
  if (state.status === "conflict") {
    return <p className={s.error} role="alert">该议题已更新（可能已在对话或其他页面处理），页面已刷新为最新状态，请核对后再操作。</p>;
  }
  return null;
}
