"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { ChevronLeft, X } from "lucide-react";
import type { CardRenderProps } from "./registry";
import type { TUpdateMonthlyPlanDraftRequest } from "@warmap/contracts";
import { payloadOf, type MonthlyPlanPayload } from "./payloads";
import { registryName } from "./scopeNames";
import { ContextMark } from "@/components/ContextMark";
import { useConfirm } from "@/components/ConfirmDialog";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { browserApi } from "@/lib/api/client";
import { calendarDate, monthDayTime } from "@/lib/companyTime";
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

type PersonOption = { personId: string; displayName: string };

type TodoDraft = { id?: string; battlefieldId?: string; title: string; ownerId: string; dueAt?: string; sourceRef: string };

export type MonthlyDraftState = {
  companyOutcome: string;
  battlefields: NonNullable<TUpdateMonthlyPlanDraftRequest["battlefields"]>;
  capabilities: NonNullable<TUpdateMonthlyPlanDraftRequest["capabilities"]>;
  todos: TodoDraft[];
  note: string;
};

/**
 * 只提交真正改动的字段：服务端按「请求里出现了哪些字段」取消该字段的核对，
 * 全量提交会让无关编辑把已核对的项一起清空。核对项由独立 checkbox Action 提交，不在这里。
 */
export function monthlyDraftPatch(payload: MonthlyPlanPayload, draft: MonthlyDraftState): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.companyOutcome !== payload.companyOutcome) patch.companyOutcome = draft.companyOutcome;
  if (JSON.stringify(draft.battlefields) !== JSON.stringify(payload.battlefields)) patch.battlefields = draft.battlefields;
  if (JSON.stringify(draft.capabilities) !== JSON.stringify(payload.capabilities)) patch.capabilities = draft.capabilities;
  if (JSON.stringify(draft.todos) !== JSON.stringify(payload.todos)) patch.todos = draft.todos;
  if (draft.note !== payload.negotiation.note) patch.note = draft.note;
  return patch;
}

type RecipientRow = { battlefieldId: string; name: string; people: string[] };

/** 签发确认：按战场列出签发后拿到任务卡的人；名单为空的战场标出来，签发不拦。 */
export function SignRecipients({ month, rows, onEdit }: { month: number; rows: RecipientRow[] | "loading" | "error"; onEdit: (battlefieldId: string) => void }) {
  return (
    <section className={s.recipients} aria-label="任务卡起草名单">
      <p className={s.recipientsTitle}>签发后为这些人起草 {month} 月任务卡并直接发给本人</p>
      {rows === "loading" ? (
        <p className={s.recipientsNote} role="status">正在读取名单…</p>
      ) : rows === "error" ? (
        <p className={s.recipientsNote} role="status">名单暂时读取失败</p>
      ) : (
        <ul className={s.recipientList}>
          {rows.map((row) => (
            <li key={row.battlefieldId}>
              <span className={s.recipientBattlefield}>{row.name}</span>
              <span className={s.recipientNames} data-empty={row.people.length === 0 || undefined}>{row.people.length ? row.people.join("、") : "名单为空"}</span>
              <button type="button" className={s.recipientEdit} onClick={() => onEdit(row.battlefieldId)}>
                改参与者
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** MonthlyPlan：CEO 编辑公司/战场结果与普通待办，签发后生效；不跟踪待办执行状态。 */
export function MonthlyPlanCard({ card, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<MonthlyPlanPayload>(card);
  const { homeCards } = useWorkspace();
  const router = useRouter();
  const { state, run, retry, pending } = useCardAction(onCard);
  const confirm = useConfirm();
  // 战场 / 能力写名称（首页注册表），找不到才退回层级，不打印原始 id。
  const battlefieldName = (id: string) => registryName(homeCards, "battlefield", id) ?? "未登记战场";
  const capabilityName = (id: string) => registryName(homeCards, "capability", id) ?? "未登记能力";
  const [companyOutcome, setCompanyOutcome] = useState(payload.companyOutcome);
  const [battlefields, setBattlefields] = useState(payload.battlefields);
  const [capabilities, setCapabilities] = useState(payload.capabilities);
  const [todos, setTodos] = useState<TodoDraft[]>(payload.todos);
  const [note, setNote] = useState(payload.negotiation.note);
  const [checked, setChecked] = useState<string[]>(payload.negotiation.checkedItemIds);
  const [signArmed, setSignArmed] = useState(false);
  const [recipients, setRecipients] = useState<Map<string, string[]> | "error" | null>(null);
  const [people, setPeople] = useState<PersonOption[] | null>(null);
  const [peopleError, setPeopleError] = useState(false);

  // 普通待办的负责人按姓名选（人员目录与议题页同一个接口），提交的仍是 personId。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/people", { headers: { accept: "application/json" } });
        if (cancelled) return;
        if (!response.ok) return setPeopleError(true);
        const body = (await response.json()) as { people: PersonOption[] };
        if (!cancelled) setPeople(body.people);
      } catch {
        if (!cancelled) setPeopleError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 服务端是唯一事实来源：只回写服务端真正改过的字段，避免任何一次 Action 都吞掉未保存的输入。
  const synced = useRef(payload);
  useEffect(() => {
    const previous = synced.current;
    synced.current = payload;
    const regenerated = payload.generation.status === "ready" && payload.generation.generatedAt !== previous.generation.generatedAt;
    if (regenerated || payload.companyOutcome !== previous.companyOutcome) setCompanyOutcome(payload.companyOutcome);
    if (regenerated || JSON.stringify(payload.battlefields) !== JSON.stringify(previous.battlefields)) setBattlefields(payload.battlefields);
    if (regenerated || JSON.stringify(payload.capabilities) !== JSON.stringify(previous.capabilities)) setCapabilities(payload.capabilities);
    if (regenerated || JSON.stringify(payload.todos) !== JSON.stringify(previous.todos)) setTodos(payload.todos);
    if (regenerated || payload.negotiation.note !== previous.negotiation.note) setNote(payload.negotiation.note);
    // 核对项永远跟着服务端走：编辑过的字段会被服务端取消核对，本地不保留过期勾选。
    setChecked(payload.negotiation.checkedItemIds);
    setSignArmed(false);
  }, [payload]);

  // 签发确认时按战场列出会拿到任务卡的人（战场配置里的参与者）；读不到名单不拦签发。
  useEffect(() => {
    if (!signArmed) return;
    let cancelled = false;
    setRecipients(null);
    browserApi.GET("/api/config/battlefields").then(({ data, response }) => {
      if (!cancelled) setRecipients(response.ok && data ? new Map(data.battlefields.map((item) => [item.id, item.participantIds])) : "error");
    }, () => {
      if (!cancelled) setRecipients("error");
    });
    return () => {
      cancelled = true;
    };
  }, [signArmed]);

  useEffect(() => {
    if (payload.generation.status !== "pending" && payload.generation.status !== "running") return;
    let stopped = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { data } = await browserApi.GET("/api/cards/monthly-plans/{id}", { params: { path: { id: card.objectRef.id } } });
        const updated = data?.cards[0];
        if (!stopped && updated && updated.version > card.version) onCard(updated);
      } catch (error) {
        console.error("Monthly plan refresh failed", error);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [card.objectRef.id, card.version, onCard, payload.generation.status]);

  const actions = card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const locked = payload.status === "confirmed" || payload.generation.status === "pending" || payload.generation.status === "running";
  const patch = monthlyDraftPatch(payload, { companyOutcome, battlefields, capabilities, todos, note });
  const dirty = Object.keys(patch).length > 0;

  /** 签发后系统为各战场起草任务卡：刷新首页，通知栏随即出现起草进度。 */
  async function signPlan() {
    if (await run(actionOf("monthly-plan.sign")!, {})) router.refresh();
  }

  async function regenerateDraft() {
    const action = actionOf("monthly-plan.retry_draft");
    if (!action || pending) return;
    if (!(await confirm.ask("重新生成会覆盖当前草案里已有的改动和核对。确定继续吗？", "重新生成"))) return;
    void run(action, {});
  }

  /**
   * 核对项必须有稳定 id：company、battlefield:<id>、capability:<id>、todo:<id>；签发前要求全部核对。
   * 编辑过的字段会被服务端取消核对，所以核对单独提交，不与内容编辑混在同一次 update_draft。
   */
  async function toggleChecked(id: string) {
    const previous = checked;
    const next = checked.includes(id) ? checked.filter((value) => value !== id) : [...checked, id];
    setChecked(next);
    const action = actionOf("monthly-plan.update_draft");
    if (!action) return;
    // C-04：服务端没接收就退回原勾选（冲突时服务端的最新卡随后会把勾选同步过来），错误与重试由 ActionFeedback 显示。
    if (!(await run(action, { checkedItemIds: next }))) setChecked(previous);
  }

  function checkable(id: string, label: string) {
    return (
      <label className={s.check}>
        <span>
          <input type="checkbox" checked={checked.includes(id)} disabled={locked} onChange={() => void toggleChecked(id)} /> 已核对 {label}
        </span>
      </label>
    );
  }

  /** 眉题（clark 月度协商）：月份 + 状态；已签发看签发日期，协商中看草案生成状态。 */
  const [year, month] = payload.period.split("-");
  const status =
    payload.status === "confirmed"
      ? `已签发${payload.confirmedAt ? ` · ${calendarDate(payload.confirmedAt)}` : ""}`
      : `协商中 · ${GENERATION_LABEL[payload.generation.status] ?? payload.generation.status}`;
  const eyebrow = `月度协商 · ${year} 年 ${Number(month)} 月 · ${status}`;

  return (
    <section className={s.workspace} data-testid="monthly-workspace" aria-labelledby="monthly-title">
      <header className={s.header}>
        <div className={s.identity}>
          <ContextMark kind="monthly" />
          <div>
            <span className={s.eyebrow}>{eyebrow}</span>
            <h1 id="monthly-title">月度计划 {payload.period}</h1>
          </div>
        </div>
        <Button isIconOnly variant="tertiary" className={s.close} data-close-view onPress={() => onNavigate("/")} aria-label="关闭月度计划">
          <X size={19} aria-hidden="true" className={s.closeIcon} />
          <ChevronLeft size={24} aria-hidden="true" className={s.backIcon} />
        </Button>
      </header>

      <div className={s.body}>
        <div className={s.materials}>
          <div className={s.resultsColumn}>
            {payload.generation.error ? (
              <p className={s.basis} role="alert" title={payload.generation.error.code}>
                {payload.generation.error.message}
              </p>
            ) : null}
            {payload.status !== "confirmed" && payload.generation.beforeReview ? (
              <div className={s.stale} role="note">
                <span>草案生成于复盘之前</span>
                {actionOf("monthly-plan.retry_draft") ? (
                  <button type="button" className={s.reviewButton} disabled={pending || locked} onClick={() => void regenerateDraft()}>
                    重新生成
                  </button>
                ) : null}
              </div>
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
                <h2 className={s.sectionTitle}>{battlefieldName(battlefield.battlefieldId)} · 战场结果</h2>
                <textarea
                  aria-label={`${battlefieldName(battlefield.battlefieldId)} 战场结果`}
                  value={battlefield.outcome}
                  disabled={locked}
                  rows={2}
                  onChange={(event) =>
                    setBattlefields((current) =>
                      current.map((item) => (item.battlefieldId === battlefield.battlefieldId ? { ...item, outcome: event.target.value } : item)),
                    )
                  }
                />
                {checkable(`battlefield:${battlefield.battlefieldId}`, `${battlefieldName(battlefield.battlefieldId)} 战场结果`)}
              </section>
            ))}

            {capabilities.map((capability) => (
              <section key={capability.capabilityId} className={s.section}>
                <h2 className={s.sectionTitle}>{capabilityName(capability.capabilityId)} · 能力 PO</h2>
                <textarea
                  aria-label={`${capabilityName(capability.capabilityId)} 能力 PO`}
                  value={capability.outcome}
                  disabled={locked}
                  rows={2}
                  onChange={(event) =>
                    setCapabilities((current) =>
                      current.map((item) => (item.capabilityId === capability.capabilityId ? { ...item, outcome: event.target.value } : item)),
                    )
                  }
                />
                {checkable(`capability:${capability.capabilityId}`, `${capabilityName(capability.capabilityId)} 能力 PO`)}
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
                    <span className={s.battlefieldBadge}>{todo.battlefieldId ? battlefieldName(todo.battlefieldId) : "公司级"}</span>
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
                    <span>负责人</span>
                    {people ? (
                      <select
                        value={todo.ownerId}
                        disabled={locked}
                        onChange={(event) => setTodos((current) => current.map((item, i) => (i === index ? { ...item, ownerId: event.target.value } : item)))}
                      >
                        {todo.ownerId && !people.some((person) => person.personId === todo.ownerId) ? (
                          <option value={todo.ownerId}>未在人员目录中（{todo.ownerId}）</option>
                        ) : null}
                        {todo.ownerId ? null : <option value="">选择负责人</option>}
                        {people.map((person) => (
                          <option key={person.personId} value={person.personId}>
                            {person.displayName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={todo.ownerId}
                        disabled={locked}
                        aria-describedby={peopleError ? "monthly-people-error" : undefined}
                        onChange={(event) => setTodos((current) => current.map((item, i) => (i === index ? { ...item, ownerId: event.target.value } : item)))}
                      />
                    )}
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
              {peopleError && todos.length ? (
                <p id="monthly-people-error" className={s.source} role="status">
                  人员目录暂时读取失败，负责人先按 personId 填写。
                </p>
              ) : null}
            </section>

            <section className={s.section}>
              <h2 className={s.sectionTitle}>DRI 反馈</h2>
              {payload.negotiation.feedback.length ? (
                payload.negotiation.feedback.map((feedback) => (
                  <div key={feedback.id} className={s.feedback}>
                    <p className={s.feedbackText}>{feedback.text}</p>
                    <p className={s.feedbackMeta}>
                      {monthDayTime(feedback.observedAt)}
                      {feedback.battlefieldId ? ` · ${battlefieldName(feedback.battlefieldId)}` : ""}
                      {feedback.todoId ? ` · 待办 ${todos.find((todo) => todo.id === feedback.todoId)?.title ?? "已移除的待办"}` : ""}
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
        {signArmed && actionOf("monthly-plan.sign") ? (
          <SignRecipients
            month={Number(month)}
            rows={recipients === null ? "loading" : recipients === "error" ? "error" : payload.battlefields.map(({ battlefieldId }) => ({
              battlefieldId,
              name: battlefieldName(battlefieldId),
              people: (recipients.get(battlefieldId) ?? []).map((id) => people?.find((person) => person.personId === id)?.displayName ?? id),
            }))}
            onEdit={(battlefieldId) => onNavigate(`/config/battlefields?battlefieldId=${encodeURIComponent(battlefieldId)}`)}
          />
        ) : null}
        <div className={s.commitInfo}>
          <span>签发后会更新各战场的本月目标和雷达的监测方向；不会直接改企业知识。</span>
          <small>已核对 {checked.length} 项 · 签发前必须核对企业结果、战场结果、能力结果与普通待办</small>
        </div>
        <div className={s.edit}>
          {actionOf("monthly-plan.retry_draft") ? (
            <button type="button" className={s.save} disabled={pending || locked} onClick={() => void regenerateDraft()}>
              重新生成草案
            </button>
          ) : null}
          {actionOf("monthly-plan.update_draft") ? (
            <button
              type="button"
              className={s.save}
              disabled={pending || locked || !dirty}
              onClick={() => void run(actionOf("monthly-plan.update_draft")!, patch)}
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
                onClick={() => void signPlan()}
              >
                签发计划
              </button>
            </>
          ) : null}
        </div>
      </div>
      <ActionFeedback state={state} onRetry={retry} />
      {confirm.dialog}

      {payload.status === "confirmed" ? (
        <p className={s.receipt}>
          本计划已签发，是当月目标的唯一来源。
          {payload.confirmedAt ? <small>签发于 {calendarDate(payload.confirmedAt)}</small> : null}
        </p>
      ) : null}
    </section>
  );
}
