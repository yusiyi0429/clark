"use client";

import { useMemo, useState } from "react";
import { ChevronDown, RefreshCw, Trash2 } from "lucide-react";
import type { CardRenderProps } from "./registry";
import { payloadOf, type IssuePayload } from "./payloads";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import s from "@/styles/issue-workspace.module.css";

const RESEARCH_LABEL: Record<string, string> = {
  pending: "预研排队中",
  running: "预研进行中",
  ready: "预研已完成",
  failed: "预研失败",
};

const URGENCY_LABEL: Record<string, string> = { red: "需要尽快决策", yellow: "需在窗口内决策", gray: "待决策" };

function locationLabel(location: IssuePayload["location"]): string {
  if (location.level === "battlefield") return `战场 · ${location.battlefieldId}`;
  if (location.level === "capability") return `公司能力 · ${location.capabilityId}`;
  return `公司（${location.relatedBattlefieldIds.join("、")}）`;
}

/**
 * 统一 Issue 页面：Radar 与 DRI 来源共用同一 renderer。
 * 决定、Override、重试预研、移出议题、加入 Meeting 与撤回 Receipt 都只通过 Action 提交。
 */
export function IssueCard({ card, collection, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<IssuePayload>(card);
  const { state, run, retry, pending } = useCardAction(onCard);
  const [tab, setTab] = useState<"summary" | "research">("summary");
  const [optionId, setOptionId] = useState<string | null>(null);
  const [decisionText, setDecisionText] = useState("");
  const [override, setOverride] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [joinMeetingId, setJoinMeetingId] = useState("");

  const actions = card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const doc = payload.research.doc;
  const scheduledMeetings = useMemo(
    () =>
      collection.filter(
        (candidate) => candidate.kind === "meeting" && (candidate.payload as { status?: string }).status === "scheduled",
      ),
    [collection],
  );
  const activeReceipts = payload.receipts.filter((receipt) => !receipt.revokedAt);

  return (
    <section className={s.workspace} data-testid="issue-workspace" aria-labelledby="issue-title">
      <header className={s.header}>
        <div>
          <span>
            {payload.origin === "radar" ? "Radar 升级" : "DRI 提交"} · {locationLabel(payload.location)} ·{" "}
            {URGENCY_LABEL[payload.urgency.level] ?? payload.urgency.level}
            {payload.urgency.decisionBy ? ` · 决定期限 ${payload.urgency.decisionBy.slice(0, 10)}` : ""}
          </span>
          <h1 id="issue-title">{card.title}</h1>
        </div>
        <button type="button" className={s.close} onClick={() => onNavigate("/")} aria-label="返回首页">
          <ChevronDown size={22} aria-hidden="true" />
        </button>
      </header>

      <div className={s.columns}>
        <div className={s.materials}>
          <div className={s.tabs} role="tablist" aria-label="Issue 材料">
            <button type="button" aria-pressed={tab === "summary"} onClick={() => setTab("summary")}>
              总结与判断
            </button>
            <button type="button" aria-pressed={tab === "research"} onClick={() => setTab("research")}>
              研究与依据
            </button>
          </div>

          <div className={s.reading}>
            {tab === "summary" ? (
              <>
                <p className={s.note}>
                  预研状态：{RESEARCH_LABEL[payload.research.status] ?? payload.research.status}
                  {payload.research.error ? `（${payload.research.error.code}：${payload.research.error.message}）` : ""}
                </p>
                {payload.status === "dismissed" ? (
                  <section className={s.unknown}>
                    <h2>已移出决策面</h2>
                    <p>{payload.dismissReason ?? "未填写原因"}</p>
                    <small>{payload.dismissedAt ? `移出时间 ${payload.dismissedAt.slice(0, 10)}` : null}</small>
                  </section>
                ) : payload.status === "decided" ? (
                  <section className={s.judgment}>
                    <h2>已生效决定</h2>
                    {activeReceipts.map((receipt) => (
                      <div key={receipt.id} className={s.receipt}>
                        <p>{receipt.decisionText}</p>
                        <small>
                          决定时预研：{RESEARCH_LABEL[receipt.researchStatusAtDecision] ?? receipt.researchStatusAtDecision}
                          {receipt.override ? " · Research Override" : ""} · {receipt.createdAt.slice(0, 10)}
                        </small>
                        {actionOf("issue.revoke_receipt") ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => {
                              const action = actions.find(
                                (candidate) => candidate.actionType === "issue.revoke_receipt" && candidate.itemId === receipt.id,
                              );
                              if (action) void run(action, {});
                            }}
                          >
                            撤回决定
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </section>
                ) : (
                  <>
                    <section className={s.judgment}>
                      <h2>当前判断</h2>
                      <p>{doc?.summary ?? "预研尚未产出判断。可以先重试预研，或在预研未完成时直接决定。"}</p>
                    </section>
                    <section className={s.discussion}>
                      <header>
                        <h2>决定</h2>
                        <p>
                          {payload.research.status === "ready"
                            ? "选择建议选项或直接编辑最终决定文本；提交后立即生效并可撤回。"
                            : "预研未完成。决定必须显式二次确认，Receipt 会记录当时的预研状态。"}
                        </p>
                      </header>
                      {doc?.options?.length ? (
                        <ul className={s.options}>
                          {doc.options.map((option) => (
                            <li key={option.id}>
                              <button
                                type="button"
                                aria-pressed={optionId === option.id}
                                onClick={() => {
                                  setOptionId(option.id);
                                  setDecisionText(option.label);
                                }}
                              >
                                {option.label}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <label className={s.field}>
                        最终决定文本
                        <textarea
                          value={decisionText}
                          onChange={(event) => setDecisionText(event.target.value)}
                          rows={3}
                          placeholder="写下你真正批准的决定"
                        />
                      </label>
                      {payload.research.status !== "ready" ? (
                        <label className={s.check}>
                          <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} />
                          我确认在预研未完成时直接决定
                        </label>
                      ) : null}
                      <div className={s.actionRow}>
                        {payload.research.status === "ready" && actionOf("issue.decide") ? (
                          <button
                            type="button"
                            disabled={pending || !decisionText.trim()}
                            onClick={() => void run(actionOf("issue.decide")!, { decisionText: decisionText.trim(), ...(optionId ? { optionId } : {}) })}
                          >
                            {pending ? "提交中…" : "直接决定"}
                          </button>
                        ) : null}
                        {actionOf("issue.decide_override") ? (
                          <button
                            type="button"
                            disabled={pending || !override || !decisionText.trim()}
                            onClick={() => void run(actionOf("issue.decide_override")!, { decisionText: decisionText.trim(), confirmOverride: true })}
                          >
                            {pending ? "提交中…" : "预研未完成时直接决定"}
                          </button>
                        ) : null}
                        {actionOf("issue.retry_research") ? (
                          <button type="button" disabled={pending} onClick={() => void run(actionOf("issue.retry_research")!, {})}>
                            <RefreshCw size={14} aria-hidden="true" />
                            {pending ? "提交中…" : "重新预研"}
                          </button>
                        ) : null}
                      </div>
                      <ActionFeedback state={state} onRetry={retry} />
                    </section>

                    <section className={s.discussion}>
                      <header>
                        <h2>决策路径</h2>
                        <p>Meeting 是 pending Issue 的可选路径；也可以直接决定。</p>
                      </header>
                      {actionOf("issue.join_meeting") ? (
                        <div className={s.actionRow}>
                          <label className={s.field}>
                            加入已有 Meeting
                            <select value={joinMeetingId} onChange={(event) => setJoinMeetingId(event.target.value)}>
                              <option value="">选择 scheduled Meeting</option>
                              {scheduledMeetings.map((meeting) => (
                                <option key={meeting.objectRef.id} value={meeting.objectRef.id}>
                                  {meeting.title}
                                </option>
                              ))}
                            </select>
                          </label>
                          <button
                            type="button"
                            disabled={pending || !joinMeetingId}
                            onClick={() => void run(actionOf("issue.join_meeting")!, { meetingId: joinMeetingId })}
                          >
                            {pending ? "提交中…" : "加入 Meeting"}
                          </button>
                        </div>
                      ) : null}
                    </section>

                    <section className={s.preflightActions}>
                      <h2>移出决策面</h2>
                      <label className={s.field}>
                        原因
                        <input value={dismissReason} onChange={(event) => setDismissReason(event.target.value)} placeholder="例如：误升级" />
                      </label>
                      <div className={s.actionRow}>
                        {actionOf("issue.dismiss") ? (
                          <button
                            type="button"
                            disabled={pending || !dismissReason.trim()}
                            onClick={() => void run(actionOf("issue.dismiss")!, { reason: dismissReason.trim() })}
                          >
                            <Trash2 size={14} aria-hidden="true" />
                            {pending ? "提交中…" : "移出议题"}
                          </button>
                        ) : null}
                      </div>
                    </section>
                  </>
                )}
              </>
            ) : (
              <>
                <p className={s.note}>唯一预研深度：判断、选择、后果、证据、未知与来源只存在这份 ResearchDoc。</p>
                {doc ? (
                  <div className={s.prose}>
                    <h3>摘要</h3>
                    <p>{doc.summary}</p>
                    <h3>选择与后果</h3>
                    <ol>
                      {doc.options.map((option) => (
                        <li key={option.id}>
                          <span>{option.id}</span>
                          <div>
                            <p>{option.label}</p>
                            <ul>
                              {option.consequences.map((consequence) => (
                                <li key={consequence}>{consequence}</li>
                              ))}
                            </ul>
                          </div>
                        </li>
                      ))}
                    </ol>
                    <h3>证据</h3>
                    {doc.evidence.map((item) => (
                      <blockquote key={item.quote}>
                        <p>{item.quote}</p>
                        <footer>
                          {item.sourceUrl ? (
                            <a href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
                              {item.sourceTitle}
                            </a>
                          ) : (
                            item.sourceTitle
                          )}
                        </footer>
                      </blockquote>
                    ))}
                    <h3>还没弄清</h3>
                    <ul>
                      {doc.unknowns.map((unknown) => (
                        <li key={unknown}>{unknown}</li>
                      ))}
                    </ul>
                    <h3>来源</h3>
                    <ul>
                      {doc.sources.map((source) => (
                        <li key={source.url}>
                          <a href={source.url} target="_blank" rel="noreferrer noopener">
                            {source.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p>{RESEARCH_LABEL[payload.research.status] ?? "预研尚未产出文档"}。</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
