"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CardRenderProps } from "./registry";
import { payloadOf, type MonthlyPlanPayload } from "./payloads";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import s from "@/styles/monthly-workspace.module.css";

const GENERATION_LABEL: Record<string, string> = {
  pending: "草案排队中",
  running: "草案生成中",
  ready: "草案已就绪",
  failed: "草案生成失败",
};

const EXPORT_LABEL: Record<string, string> = {
  pending_export: "待外发",
  delivered: "已送达",
  failed: "外发失败",
};

type TodoDraft = { id?: string; battlefieldId?: string; title: string; ownerId: string; dueAt?: string; sourceRef: string };

/** MonthlyPlan：CEO 编辑公司/战场结果与普通待办，签发后生效；不跟踪待办执行状态。 */
export function MonthlyPlanCard({ card, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<MonthlyPlanPayload>(card);
  const { state, run, retry, pending } = useCardAction(onCard);
  const [companyOutcome, setCompanyOutcome] = useState(payload.companyOutcome);
  const [battlefields, setBattlefields] = useState(payload.battlefields);
  const [todos, setTodos] = useState<TodoDraft[]>(payload.todos);
  const [note, setNote] = useState(payload.negotiation.note);
  const [checked, setChecked] = useState<string[]>(payload.negotiation.checkedItemIds);
  const [signArmed, setSignArmed] = useState(false);

  // 服务端是唯一事实来源：只回写服务端真正改过的字段，避免任何一次 Action 都吞掉未保存的输入。
  const synced = useRef(payload);
  useEffect(() => {
    const previous = synced.current;
    synced.current = payload;
    if (payload.companyOutcome !== previous.companyOutcome) setCompanyOutcome(payload.companyOutcome);
    if (JSON.stringify(payload.battlefields) !== JSON.stringify(previous.battlefields)) setBattlefields(payload.battlefields);
    if (JSON.stringify(payload.todos) !== JSON.stringify(previous.todos)) setTodos(payload.todos);
    if (payload.negotiation.note !== previous.negotiation.note) setNote(payload.negotiation.note);
    // 核对项永远跟着服务端走：编辑过的字段会被服务端取消核对，本地不保留过期勾选。
    setChecked(payload.negotiation.checkedItemIds);
    setSignArmed(false);
  }, [payload]);

  const actions = card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const locked = payload.status === "confirmed" || payload.generation.status === "pending" || payload.generation.status === "running";

  /**
   * 核对项必须有稳定 id：company、battlefield:<id>、todo:<id>；签发前要求全部核对。
   * 编辑过的字段会被服务端取消核对，所以核对单独提交，不与内容编辑混在同一次 update_draft。
   */
  function toggleChecked(id: string) {
    const next = checked.includes(id) ? checked.filter((value) => value !== id) : [...checked, id];
    setChecked(next);
    const action = actionOf("monthly-plan.update_draft");
    if (action) void run(action, { checkedItemIds: next });
  }

  function checkable(id: string, label: string) {
    return (
      <label className={s.check}>
        <span>
          <input type="checkbox" checked={checked.includes(id)} disabled={locked} onChange={() => toggleChecked(id)} /> 已核对 {label}
        </span>
      </label>
    );
  }

  /** pen Eyebrow 只两段：已签发看签发日期，协商中看草案生成状态。 */
  const eyebrow =
    payload.status === "confirmed"
      ? `已签发${payload.confirmedAt ? ` · ${payload.confirmedAt.slice(0, 10)}` : ""}`
      : `协商中 · ${GENERATION_LABEL[payload.generation.status] ?? payload.generation.status}`;

  return (
    <section className={s.workspace} data-testid="monthly-workspace" aria-labelledby="monthly-title">
      <header className={s.header}>
        <div className={s.identity}>
          <span className={s.marker} aria-hidden="true" />
          <div>
            <span className={s.eyebrow}>{eyebrow}</span>
            <h1 id="monthly-title">月度计划 {payload.period}</h1>
          </div>
        </div>
        <button type="button" className={s.close} onClick={() => onNavigate("/")} aria-label="返回首页">
          <X size={19} aria-hidden="true" />
        </button>
      </header>

      <div className={s.body}>
        <div className={s.materials}>
          <div className={s.resultsColumn}>
            {payload.generation.error ? (
              <p className={s.basis} role="alert">
                {payload.generation.error.code}：{payload.generation.error.message}
                {actionOf("monthly-plan.retry_draft") ? (
                  <button type="button" disabled={pending} onClick={() => void run(actionOf("monthly-plan.retry_draft")!, {})}>
                    重试生成
                  </button>
                ) : null}
              </p>
            ) : null}

            <section className={s.section}>
              <h2 className={s.sectionTitle}>公司结果</h2>
              <textarea
                aria-label="公司结果"
                value={companyOutcome}
                onChange={(event) => setCompanyOutcome(event.target.value)}
                rows={3}
                disabled={locked}
              />
              {checkable("company", "公司结果")}
            </section>

            {battlefields.map((battlefield) => (
              <section key={battlefield.battlefieldId} className={s.section}>
                <h2 className={s.sectionTitle}>{battlefield.battlefieldId} 战场结果</h2>
                <textarea
                  aria-label={`${battlefield.battlefieldId} 战场结果`}
                  value={battlefield.outcome}
                  disabled={locked}
                  rows={2}
                  onChange={(event) =>
                    setBattlefields((current) =>
                      current.map((item) => (item.battlefieldId === battlefield.battlefieldId ? { ...item, outcome: event.target.value } : item)),
                    )
                  }
                />
                {checkable(`battlefield:${battlefield.battlefieldId}`, `${battlefield.battlefieldId} 战场结果`)}
              </section>
            ))}
          </div>

          <div className={s.feedbackColumn}>
            <section className={s.section}>
              <h2 className={s.sectionTitle}>普通待办</h2>
              {todos.map((todo, index) => (
                <article key={todo.id ?? `draft-${index}`} className={s.todo}>
                  <div className={s.todoHead}>
                    <span className={s.todoIndex}>{String(index + 1).padStart(2, "0")}</span>
                    <span className={s.battlefieldBadge}>{todo.battlefieldId ?? "公司级"}</span>
                  </div>
                  <label className={s.notes}>
                    <span>待办</span>
                    <input
                      value={todo.title}
                      disabled={locked}
                      onChange={(event) => setTodos((current) => current.map((item, i) => (i === index ? { ...item, title: event.target.value } : item)))}
                    />
                  </label>
                  <label className={s.notes}>
                    <span>负责人（personId）</span>
                    <input
                      value={todo.ownerId}
                      disabled={locked}
                      onChange={(event) => setTodos((current) => current.map((item, i) => (i === index ? { ...item, ownerId: event.target.value } : item)))}
                    />
                  </label>
                  <label className={s.notes}>
                    <span>可选截止</span>
                    <input
                      value={todo.dueAt ?? ""}
                      disabled={locked}
                      placeholder="YYYY-MM-DD"
                      onChange={(event) => setTodos((current) => current.map((item, i) => (i === index ? { ...item, dueAt: event.target.value || undefined } : item)))}
                    />
                  </label>
                  <p className={s.source}>
                    来源：{todo.sourceRef}
                    {payload.exports.find((item) => item.todoId === todo.id)
                      ? ` · ${EXPORT_LABEL[payload.exports.find((item) => item.todoId === todo.id)!.status] ?? ""}`
                      : ""}
                  </p>
                  {todo.id ? checkable(`todo:${todo.id}`, todo.title) : null}
                </article>
              ))}
              {todos.length === 0 ? <p className={s.empty}>本月没有普通待办。</p> : null}
            </section>

            <section className={s.section}>
              <h2 className={s.sectionTitle}>DRI 反馈</h2>
              {payload.negotiation.feedback.length ? (
                payload.negotiation.feedback.map((feedback) => (
                  <div key={feedback.id} className={s.feedback}>
                    <p className={s.feedbackText}>{feedback.text}</p>
                    <p className={s.feedbackMeta}>
                      {feedback.observedAt.slice(0, 16).replace("T", " ")}
                      {feedback.battlefieldId ? ` · ${feedback.battlefieldId}` : ""}
                      {feedback.todoId ? ` · 待办 ${feedback.todoId}` : ""}
                    </p>
                  </div>
                ))
              ) : (
                <p className={s.empty}>尚未收到 DRI 反馈。</p>
              )}
            </section>

            <section className={s.section}>
              <h2 className={s.sectionTitle}>备注</h2>
              <textarea aria-label="备注" value={note} disabled={locked} rows={2} onChange={(event) => setNote(event.target.value)} />
            </section>
          </div>
        </div>
      </div>

      <div className={s.commitArea}>
        <div className={s.commitInfo}>
          <span>签发后刷新战场目标与 Radar 基础 anchors；不直接更新企业知识。</span>
          <small>已核对 {checked.length} 项 · 签发前必须核对企业结果、战场结果与普通待办</small>
        </div>
        <div className={s.edit}>
          {actionOf("monthly-plan.update_draft") ? (
            <button
              type="button"
              className={s.save}
              disabled={pending || locked}
              onClick={() => void run(actionOf("monthly-plan.update_draft")!, { companyOutcome, battlefields, todos, checkedItemIds: checked, note })}
            >
              {pending ? "保存中…" : "保存计划"}
            </button>
          ) : null}
          {actionOf("monthly-plan.sign") ? (
            <>
              <label className={s.check}>
                <span>
                  <input type="checkbox" checked={signArmed} disabled={locked} onChange={(event) => setSignArmed(event.target.checked)} /> 我确认签发{" "}
                  {payload.period} 计划，签发后成为当月目标唯一来源
                </span>
              </label>
              <button
                type="button"
                className={s.submit}
                disabled={pending || locked || !signArmed}
                onClick={() => void run(actionOf("monthly-plan.sign")!, {})}
              >
                签发计划
              </button>
            </>
          ) : null}
        </div>
      </div>
      <ActionFeedback state={state} onRetry={retry} />

      {payload.status === "confirmed" ? (
        <p className={s.receipt}>
          本计划已签发，是当月目标的唯一来源。
          {payload.confirmedAt ? <small>签发于 {payload.confirmedAt.slice(0, 10)}</small> : null}
        </p>
      ) : null}
    </section>
  );
}
