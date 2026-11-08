"use client";

/**
 * Task 管线里的开工（新首页设计第 2 节，替换以前派活单的「开工」块）：规划员拆好的几步摆在选项框里，
 * 「就按这个开始（推荐）/ 改一改 / 自己说」。选了就开：卡放进看板，在这台电脑上一次交给本机（同时最多 3 个，多的排队），子会话出现在左边。
 * 改一改：就地改每步的标题、换岗位、去掉一步，模型在每步右边换。自己说：这句话发进 Task 管线。
 * 手机、本机没连时选「开始」，卡排成等开工，回到这台电脑上打开天枢时自己开（HomeShell）。
 * 另外两块：规划员在拆时的一行（拆卡中 · 第几步），开了以后选项框收成一行、计划的几步变成子会话行（和左栏同样式、带竖线，原地跟着状态变）。
 * 样子照设计 5.4.3「开工的特别规矩」：问题「{Task 名}：这样开工？」，编号的几步 14/20，每步下面一行「岗位 · 约定第 N 条」，再一行「N 个子会话」；
 * 岗位、模型、文件夹点了用弹层选（全站唯一那种弹层）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Dropdown } from "@heroui/react";
import { Check, ChevronDown, X } from "lucide-react";
import type { TBudget, TBudgetMode, TCardDraftView } from "@warmap/contracts";
import { DecisionBox } from "@/components/work/DecisionBox";
import { ApprovalDecision, QuestionDecision, awayChip } from "@/components/work/decisions";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { useHandheld } from "@/components/ui/useHandheld";
import { canCommandHere } from "@/lib/work/actions";
import { Slots } from "@/components/work/Slots";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { planStep } from "@/lib/local/sessionView";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { readLast, writeLast } from "@/lib/local/start";
import type { TLocalModelProfile } from "@/lib/local/runner";
import { acceptDrafts, acceptProjectDrafts, dismissDraft, readTaskBudget, type PlanTarget } from "@/lib/board/cloud";
import { TIER_LABEL, draftRole, modelForTier, type CardRole, type RoleView } from "@/lib/team/roles";
import { SLOT_CAP, startBatch, type StartPlan } from "@/lib/work/queue";
import { QUEUE_LABEL, liveSessions, type Worker } from "@/lib/work/workers";
import type { SubSession } from "@/lib/home/types";
import { ICON as STATE_ICON, StateIcon } from "./StateIcon";
import { subIcon } from "./LeftColumn";
import { queueText } from "@/lib/home/derive";
import h from "@/styles/home.module.css";
import x from "@/styles/decision-box.module.css";
import { SourceWords } from "@/components/cards/SourceWords";

const ICON = STATE_ICON;

/** 草稿行配的岗位：拆卡给的；没给时执行方是自己的为 null（人自己的活），否则写 Claude Code。 */
export function draftWorkerRole(draft: TCardDraftView): CardRole | null {
  return draftRole(draft) ?? (draft.executor === "self" ? null : { id: "", name: "Claude Code", kind: "worker" });
}

type Edit = { title?: string; role?: CardRole | null; modelId?: string; dropped?: boolean };
export const START_LABEL = "就按这个开始";

/** 开工的模式（11.3）：自动（默认）· 设预算 · 无上限。 */
export const MODES: { id: TBudgetMode; label: string }[] = [{ id: "auto", label: "自动" }, { id: "set", label: "设预算" }, { id: "unlimited", label: "无上限" }];
/** 设预算时填的几项（字符串，照输入框原样）；不是有效数的那项不算。 */
export type Limits = { hours: string; percent: string; money: string };
const NO_LIMITS: Limits = { hours: "", percent: "", money: "" };
const positive = (value: string, max: number) => { const n = Number(value); return value.trim() && Number.isFinite(n) && n > 0 && n <= max ? n : null; };
/** 选的模式和填的上限 → 契约的 Budget；设预算却一项有效的上限都没有时为 null（发不出去）。 */
export function budgetOf(mode: TBudgetMode, limits: Limits): TBudget | null {
  if (mode !== "set") return { mode, hours: null, weeklyPercent: null, money: null };
  const hours = positive(limits.hours, 1000);
  const percent = positive(limits.percent, 100);
  const amount = positive(limits.money, 1_000_000);
  const budget: TBudget = { mode, hours, weeklyPercent: percent !== null && Number.isInteger(percent) ? percent : null, money: amount !== null ? { amount, currency: "CNY" } : null };
  return budget.hours !== null || budget.weeklyPercent !== null || budget.money !== null ? budget : null;
}
export const limitsOf = (budget: TBudget): Limits => ({ hours: budget.hours?.toString() ?? "", percent: budget.weeklyPercent?.toString() ?? "", money: budget.money?.amount.toString() ?? "" });

/**
 * target：拆的是一件 Task，还是一个没挂 Task 的项目（16.3）；name 是框顶上的名字。项目的没有预算那一栏：不挂 Task，开工用本人的缺省预算。
 */
export function PlanDecision({ target, name, drafts, roles, handheld, onSay, onChanged }: {
  target: PlanTarget;
  name: string;
  drafts: TCardDraftView[];
  roles: RoleView[];
  handheld: boolean;
  /** 「自己说」：发进 Task 管线。 */
  onSay: (text: string) => Promise<unknown>;
  onChanged: () => void;
}) {
  const local = useLocalRunner();
  const ready = local.phase === "ready" && !handheld;
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [folderId, setFolderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 模式从这件 Task 现在的预算开始（没设过是本人的缺省，读不到就是「自动」）；本人动过才随开工存回去。
  const [mode, setMode] = useState<TBudgetMode>("auto");
  const [limits, setLimits] = useState<Limits>(NO_LIMITS);
  const touched = useRef(false);
  const hoursRef = useRef<HTMLInputElement>(null);
  const taskId = "taskId" in target ? target.taskId : null;
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    void readTaskBudget(taskId).then((found) => {
      if (!alive || !found || touched.current) return;
      setMode(found.budget.mode);
      setLimits(limitsOf(found.budget));
    }, () => undefined);
    return () => { alive = false; };
  }, [taskId]);
  const pickMode = (next: TBudgetMode) => { touched.current = true; setMode(next); if (next === "set") requestAnimationFrame(() => hoursRef.current?.focus()); };
  const setLimit = (key: keyof Limits, value: string) => { touched.current = true; setLimits((current) => ({ ...current, [key]: value })); };
  useEffect(() => { setFolderId((current) => current ?? local.folders.find((folder) => folder.id === readLast().folderId)?.id ?? local.folders[0]?.id ?? null); }, [local.folders]);
  const workerRoles = useMemo(() => roles.filter((role) => role.kind === "worker"), [roles]);
  const folder = local.folders.find((entry) => entry.id === folderId) ?? null;
  const kept = drafts.filter((draft) => !edits[draft.id]?.dropped);
  const used = liveSessions(local.sessions).length;
  const roleOf = (draft: TCardDraftView) => { const edit = edits[draft.id]; return edit && "role" in edit ? edit.role ?? null : draftWorkerRole(draft); };
  const tierOf = (draft: TCardDraftView, role: CardRole | null) => roles.find((entry) => entry.id === role?.id)?.modelTier ?? draft.modelTier;
  const modelOf = (draft: TCardDraftView): TLocalModelProfile | null => {
    const role = roleOf(draft);
    if (!role) return null;
    return local.models.find((model) => model.id === edits[draft.id]?.modelId) ?? modelForTier(local.models, tierOf(draft, role));
  };
  const edit = (id: string, patch: Edit) => setEdits((current) => ({ ...current, [id]: { ...current[id], ...patch } }));

  const start = async () => {
    if (!kept.length || busy) return;
    // 设预算却一项都没填对：停在填的地方。
    const budget = taskId ? budgetOf(mode, limits) : null;
    if (taskId && !budget) { hoursRef.current?.focus(); return; }
    let where = folder;
    if (ready && !where) {
      where = await local.pickFolder();
      if (!where) return;
      setFolderId(where.id);
    }
    setBusy(true);
    try {
      for (const draft of drafts.filter((entry) => edits[entry.id]?.dropped)) await dismissDraft(draft.id).catch(() => undefined);
      // 换过岗位的随放进看板一起记到卡上（没有岗位的是人自己的活）。
      // 这台电脑能开就马上开（带上每张卡选的模型）；开不了（手机、本机没连）就登记要开工，配对的电脑上开着的网页认领后开（第 4.4 节）。
      const picked = kept.map((draft) => {
        const role = roleOf(draft);
        const changed = (role?.id || null) !== (draftRole(draft)?.id ?? null);
        return { id: draft.id, ...(edits[draft.id]?.title?.trim() ? { title: edits[draft.id]!.title!.trim() } : {}), ...(changed ? { roleId: role?.id || null } : {}) };
      });
      const cards = taskId ? await acceptDrafts(taskId, picked, !(ready && where), touched.current && budget ? budget : undefined)
        : await acceptProjectDrafts((target as { projectId: string }).projectId, picked, !(ready && where));
      const plans: StartPlan[] = kept.flatMap((draft, index) => {
        const item = cards[index];
        const role = roleOf(draft);
        const model = modelOf(draft);
        return item && role && model ? [{ item, model, cwd: where?.path ?? "", role: roles.find((entry) => entry.id === role.id) ?? null }] : [];
      });
      if (ready && where) {
        writeLast({ folderId: where.id });
        await startBatch(local.runner, plans);
        await local.refresh();
      }
      setEdits({});
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const agents = kept.filter((draft) => roleOf(draft)).length;
  // 设预算只出这次计划用得到的那几项（11.3）：用订阅的出本周额度，用 TokenHub 的出金额；还不知道用哪个模型时只出本周额度。
  const sources = new Set(kept.flatMap((draft) => { const model = modelOf(draft); return model ? [model.source] : []; }));
  const subscription = sources.has("subscription") || !sources.size;
  const gateway = sources.has("gateway");
  const steps = (
    <>
    <ol className={h.steps}>
      {kept.map((draft, index) => {
        const role = roleOf(draft);
        const model = modelOf(draft);
        return (
          <li key={draft.id} data-testid="plan-step">
            <span className={h.stepNo}>{index + 1}.</span>
            <span className={h.stepMain}>
              {editing ? <input value={edits[draft.id]?.title ?? draft.title} maxLength={120} aria-label="这一步" onChange={(event) => edit(draft.id, { title: event.target.value })} />
                : <span className={h.stepTitle}>{edits[draft.id]?.title ?? draft.title}</span>}
              <span className={h.stepMeta}>{[role?.name ?? "我自己", draft.criterionIndex ? `约定第 ${draft.criterionIndex} 条` : null].filter(Boolean).join(" · ")}</span>
              <SourceWords words={draft.sourceWords} className={h.stepWords} />
            </span>
            <span className={h.stepSide}>
              {editing ? <>
                <Pick label={role?.name ?? "我自己"} value={role?.id || "self"}
                  options={[...workerRoles.map((entry) => ({ id: entry.id, label: entry.name })), { id: "self", label: "我自己" }]}
                  onPick={(id) => edit(draft.id, { role: id === "self" ? null : { id, name: workerRoles.find((entry) => entry.id === id)!.name, kind: "worker" }, modelId: undefined })} />
                <button type="button" className={h.icon} aria-label={`去掉「${draft.title}」`} title="删除" onClick={() => edit(draft.id, { dropped: true })}><X {...ICON} /></button>
              </> : role ? (local.models.length ? <Pick label={model?.label ?? "模型"} value={model?.id ?? ""} options={local.models.map((entry) => ({ id: entry.id, label: entry.label }))} onPick={(id) => edit(draft.id, { modelId: id })} />
                : <span className={h.chip}>{TIER_LABEL[tierOf(draft, role)]}</span>) : null}
            </span>
          </li>
        );
      })}
    </ol>
    {agents ? <p className={h.stepSum}>{agents} 个子会话</p> : null}
    {taskId ? <div className={x.mode} data-testid="plan-mode">
      <SegmentedSwitch label="预算" segments={MODES} selected={mode} onSelect={pickMode} />
      {mode === "set" ? (
        <span className={x.limits}>
          <label><input ref={hoursRef} inputMode="decimal" value={limits.hours} aria-label="时长上限（小时）" onChange={(event) => setLimit("hours", event.target.value)} />小时</label>
          {subscription ? <label><input inputMode="numeric" value={limits.percent} aria-label="本周额度上限（百分比）" onChange={(event) => setLimit("percent", event.target.value)} />% 本周额度</label> : null}
          {gateway ? <label>¥<input inputMode="decimal" value={limits.money} aria-label="TokenHub 金额上限" onChange={(event) => setLimit("money", event.target.value)} />TokenHub</label> : null}
        </span>
      ) : null}
    </div> : null}
    </>
  );
  const footer = ready ? <>
    {folder ? <Pick label={folder.label} value={folder.id} options={local.folders.map((entry) => ({ id: entry.id, label: entry.label }))} onPick={setFolderId} up />
      : <button type="button" className={h.chip} onClick={() => void local.pickFolder().then((picked) => { if (picked) setFolderId(picked.id); })}>选文件夹</button>}
    <span className={h.grow} />
    <span className={h.slotsLine}>本机 <Slots used={used} cap={SLOT_CAP} /> {used}/{SLOT_CAP}</span>
  </> : null;

  return (
    <DecisionBox kind="plan" testId="plan-decision" title={`${name}：这样开工？`} body={steps} busy={busy} footer={footer}
      options={editing ? [{ label: START_LABEL, recommended: true }, { label: "改好了" }] : [{ label: START_LABEL, recommended: true }, { label: "改一改" }]}
      onPick={([picked]) => (picked === 0 ? start() : setEditing(!editing))}
      // 管线正在回话时发不出去（send 回 false）：算失败，框里原处写「失败 · 重试」，打的字留着。
      other={{ onSubmit: async (text) => { if ((await onSay(text)) === false) throw new Error("没发出去"); } }} />
  );
}

/** 一个小下拉：点开是弹层（全站唯一那种），当前那项行尾打勾。 */
function Pick({ label, options, value, onPick, up }: { label: string; options: { id: string; label: string }[]; value: string; onPick: (id: string) => void; up?: boolean }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.chip}>{label}<ChevronDown {...ICON} /></Dropdown.Trigger>
      <Dropdown.Popover placement={up ? "top start" : "bottom end"} offset={8} className={h.pop}>
        <Dropdown.Menu aria-label={label} className={h.menuList} onAction={(key) => onPick(String(key))}>
          {options.map((option) => (
            <Dropdown.Item key={option.id || "none"} id={option.id || "none"} textValue={option.label} className={h.menuItem}>
              <span className={h.grow}>{option.label}</span>{option.id === value ? <Check {...ICON} /> : null}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 规划员在拆：一行「拆卡中 · 第 2/3 步」；排着时写在等什么。 */
export function plannerText(planner: Worker, step: { step: number; total: number } | null): string {
  if (planner.state === "queued") return `拆卡 · ${QUEUE_LABEL[planner.reason ?? "start"]}`;
  return step ? `拆卡中 · 第 ${step.step}/${step.total} 步` : "拆卡中";
}

/** 规划员在拆：一行进度；它要权限、问你时，选项框就接在这一行下面（只有这台电脑上能答）。 */
export function PlanningLine({ planner }: { planner: Worker }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const session = planner.state === "doing" ? planner.session : null;
  const { view } = useSessionEvents(local.runner, session?.id ?? null);
  const step = planStep(view.plan) ?? (planner.step ? { step: planner.step.n, total: planner.step.total } : null);
  const blocked = canCommandHere(planner, local.phase === "ready", handheld) ? null : awayChip(planner.device);
  // 连上事件流以后只认事件流（答过、作废了就是没有），还没连上时照会话摘要。
  const question = session ? (view.lastSeq ? view.question : session.pendingQuestion ?? null) : null;
  return (
    <>
      <p className={h.line} data-testid="planning-line"><StateIcon state={planner.state === "queued" ? "queued" : "running"} />{plannerText(planner, step)}</p>
      {session && view.pending.length ? (
        <ApprovalDecision requests={view.pending} blocked={blocked} onDecide={(request, decision, { forSession, message }) => local.runner.decidePermission(session.id, request.requestId,
          { decision, ...(forSession ? { allowForSession: true } : {}), ...(message ? { message } : {}) })} />
      ) : null}
      {session && question ? (
        <QuestionDecision key={question.requestId} request={question} blocked={blocked}
          onAnswer={(body) => local.runner.answerQuestion(session.id, question.requestId, body).then(() => local.refresh())} />
      ) : null}
    </>
  );
}

const WAIT_TEXT: Record<string, string> = { approval: "等你批准", question: "等你回复", verdict: "受阻", merge: "等你合回" };
/** 事件行的阶段（5.6 状态词）。 */
export function subStage(sub: SubSession): string {
  switch (sub.state) {
    case "queued": return `已排队${sub.queueReason ? ` · ${queueText(sub.queueReason, sub.holdUntil)}` : ""}`;
    // 停下了、没在问你：「已停下」（契约 aa6aba9e）；第一次验收没过是进行中的「重做中」（5.4.2），不是失败。
    case "waiting": return sub.waiting ? WAIT_TEXT[sub.waiting] ?? "等你" : "已停下";
    case "done": return "已完成";
    case "failed": return "重做中";
    default: return "进行中";
  }
}

/**
 * 开了以后（5.4.3「事件行」）：开工的选项框收成一行（勾 · 问题 · 就按这个开始），下面是开出的子会话，一行一个（和左栏同样式、带竖线）：
 * 状态图标 · 名字 · 阶段，原地跟着状态变；子会话要批准、提问时这一行写「等你批准」，点了进子会话去答（选项框不在两处各画一遍）。
 */
export function StartedRecord({ task, subs, onOpen }: { task: string; subs: SubSession[]; onOpen: (sub: SubSession) => void }) {
  return (
    <div className={h.started} data-testid="started-record">
      <p className={h.resolvedLine}><Check {...ICON} /><span className={h.resolvedQ}>{task}：这样开工？</span><span className={h.resolvedA}>{START_LABEL}</span></p>
      <ul className={h.eventList}>
        {subs.map((sub) => (
          <li key={sub.id}>
            <button type="button" className={h.event} onClick={() => onOpen(sub)} data-state={sub.state}>
              <StateIcon {...subIcon(sub)} /><span className={h.eventName}>{sub.title}</span><span className={h.eventStage}> · {subStage(sub)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
