"use client";

/**
 * Task 管线里的开工（新首页设计第 2 节，替换以前派活单的「开工」块）：规划员拆好的几步摆在选项框里，
 * 「就按这个开始（推荐）/ 改一改 / 自己说」。选了就开：卡放进看板，在这台电脑上一次交给本机（同时最多 3 个，多的排队），子会话出现在左边。
 * 改一改：就地改每步的标题、换岗位、去掉一步，模型在每步右边换。自己说：这句话发进 Task 管线。
 * 手机、本机没连时选「开始」，卡排成等开工，回到这台电脑上打开天枢时自己开（HomeShell）。
 * 另外两块：规划员在拆时的一行（拆卡中 · 第几步），开了以后「开了哪几个子会话」的一块。
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { TCardDraftView, THomePlanTask } from "@warmap/contracts";
import { DecisionBox } from "@/components/work/DecisionBox";
import { ApprovalDecision, QuestionDecision } from "@/components/work/decisions";
import { useHandheld } from "@/components/ui/useHandheld";
import { canCommandHere } from "@/lib/work/actions";
import { Slots } from "@/components/work/Slots";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { planStep } from "@/lib/local/sessionView";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { readLast, writeLast } from "@/lib/local/start";
import type { TLocalModelProfile } from "@/lib/local/runner";
import { acceptDrafts, dismissDraft } from "@/lib/board/cloud";
import { showWorkspaceToast } from "@/lib/toast";
import { TIER_LABEL, draftRole, modelForTier, type CardRole, type RoleView } from "@/lib/team/roles";
import { SLOT_CAP, startBatch, startedText, type StartPlan } from "@/lib/work/queue";
import { QUEUE_LABEL, liveSessions, type Worker } from "@/lib/work/workers";
import type { SubSession } from "@/lib/home/types";
import { StateIcon } from "./StateIcon";
import h from "@/styles/home.module.css";

const ICON = { size: 16, strokeWidth: 1.5 } as const;

/** 草稿行配的岗位：拆卡给的；没给时执行方是自己的为 null（人自己的活），否则写 Claude Code。 */
export function draftWorkerRole(draft: TCardDraftView): CardRole | null {
  return draftRole(draft) ?? (draft.executor === "self" ? null : { id: "", name: "Claude Code", kind: "worker" });
}

type Edit = { title?: string; role?: CardRole | null; modelId?: string; dropped?: boolean };
export const START_LABEL = "就按这个开始";

export function PlanDecision({ task, drafts, roles, handheld, onSay, onChanged }: {
  task: THomePlanTask;
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
    if (ready && !folder) { showWorkspaceToast({ text: "先选一个文件夹" }); return; }
    setBusy(true);
    try {
      for (const draft of drafts.filter((entry) => edits[entry.id]?.dropped)) await dismissDraft(draft.id).catch(() => undefined);
      // 换过岗位的随放进看板一起记到卡上（没有岗位的是人自己的活）。
      const cards = await acceptDrafts(task.taskId, kept.map((draft) => {
        const role = roleOf(draft);
        const changed = (role?.id || null) !== (draftRole(draft)?.id ?? null);
        return { id: draft.id, ...(edits[draft.id]?.title?.trim() ? { title: edits[draft.id]!.title!.trim() } : {}), ...(changed ? { roleId: role?.id || null } : {}) };
      }));
      const plans: StartPlan[] = kept.flatMap((draft, index) => {
        const item = cards[index];
        const role = roleOf(draft);
        const model = modelOf(draft);
        return item && role && model ? [{ item, model, cwd: folder?.path ?? "", role: roles.find((entry) => entry.id === role.id) ?? null }] : [];
      });
      if (ready && folder) {
        writeLast({ folderId: folder.id });
        const result = await startBatch(local.runner, plans);
        await local.refresh();
        showWorkspaceToast({ text: startedText(result) });
      } else {
        showWorkspaceToast({ text: `${plans.length} 件${QUEUE_LABEL.start}` });
      }
      setEdits({});
      setEditing(false);
      onChanged();
    } catch (error) {
      showWorkspaceToast({ text: error instanceof Error ? error.message : "没开起来，请重试" });
    } finally {
      setBusy(false);
    }
  };

  const steps = (
    <ol className={h.steps}>
      {kept.map((draft) => {
        const role = roleOf(draft);
        const model = modelOf(draft);
        return (
          <li key={draft.id} data-testid="plan-step">
            <StateIcon state="queued" />
            <span className={h.stepMain}>
              {editing ? <input value={edits[draft.id]?.title ?? draft.title} maxLength={120} aria-label="这一步" onChange={(event) => edit(draft.id, { title: event.target.value })} />
                : <span className={h.stepTitle}>{edits[draft.id]?.title ?? draft.title}</span>}
              <span className={h.stepMeta}>{[role?.name ?? "我自己", draft.criterionIndex ? `约定第 ${draft.criterionIndex} 条` : null].filter(Boolean).join(" · ")}</span>
            </span>
            <span className={h.stepSide}>
              {editing ? <>
                <Pick label={role?.name ?? "我自己"} value={role?.id || "self"}
                  options={[...workerRoles.map((entry) => ({ id: entry.id, label: entry.name })), { id: "self", label: "我自己" }]}
                  onPick={(id) => edit(draft.id, { role: id === "self" ? null : { id, name: workerRoles.find((entry) => entry.id === id)!.name, kind: "worker" }, modelId: undefined })} />
                <button type="button" className={h.icon} aria-label={`去掉「${draft.title}」`} onClick={() => edit(draft.id, { dropped: true })}><X {...ICON} aria-hidden /></button>
              </> : role ? (local.models.length ? <Pick label={model?.label ?? "模型"} value={model?.id ?? ""} options={local.models.map((entry) => ({ id: entry.id, label: entry.label }))} onPick={(id) => edit(draft.id, { modelId: id })} />
                : <span className={h.chip}>{TIER_LABEL[tierOf(draft, role)]}</span>) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
  const footer = ready ? <>
    {folder ? <Pick label={folder.label} value={folder.id} options={local.folders.map((entry) => ({ id: entry.id, label: entry.label }))} onPick={setFolderId} up />
      : <button type="button" className={h.chip} onClick={() => void local.pickFolder().then((picked) => { if (picked) setFolderId(picked.id); })}>选文件夹</button>}
    <span className={h.grow} />
    <span className={h.slotsLine}>本机 <Slots used={used} cap={SLOT_CAP} /> {used}/{SLOT_CAP}</span>
  </> : null;

  return (
    <DecisionBox kind="plan" testId="plan-decision" title={`${kept.length} 步`} body={steps} busy={busy} footer={footer}
      options={editing ? [{ label: START_LABEL, recommended: true }, { label: "改好了" }] : [{ label: START_LABEL, recommended: true }, { label: "改一改" }]}
      onPick={([picked]) => (picked === 0 ? start() : setEditing(!editing))}
      other={{ onSubmit: (text) => onSay(text) }} />
  );
}

/** 一个小下拉：点开列出选项。 */
function Pick({ label, options, value, onPick, up }: { label: string; options: { id: string; label: string }[]; value: string; onPick: (id: string) => void; up?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <span className={h.pick}>
      <button type="button" className={h.chip} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}<ChevronDown {...ICON} aria-hidden /></button>
      {open ? (
        <span className={h.menu} data-up={up || undefined} role="menu" onMouseLeave={() => setOpen(false)}>
          {options.map((option) => <button key={option.id || "none"} type="button" role="menuitemradio" aria-checked={option.id === value} onClick={() => { onPick(option.id); setOpen(false); }}>{option.label}</button>)}
        </span>
      ) : null}
    </span>
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
  const blocked = canCommandHere(planner, local.phase === "ready", handheld) ? null : "到电脑上处理";
  const question = session ? view.question ?? session.pendingQuestion ?? null : null;
  const fail = (error: unknown) => showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" });
  return (
    <>
      <p className={h.line} data-testid="planning-line"><StateIcon state={planner.state === "queued" ? "queued" : "running"} />{plannerText(planner, step)}</p>
      {session && view.pending.length ? (
        <ApprovalDecision requests={view.pending} blocked={blocked} onDecide={(request, decision, { forSession, message }) => local.runner.decidePermission(session.id, request.requestId,
          { decision, ...(forSession ? { allowForSession: true } : {}), ...(message ? { message } : {}) }).catch(fail)} />
      ) : null}
      {session && question ? (
        <QuestionDecision key={question.requestId} request={question} blocked={blocked}
          onAnswer={(body) => local.runner.answerQuestion(session.id, question.requestId, body).then(() => local.refresh()).catch(fail)} />
      ) : null}
    </>
  );
}

/** 开了以后：「就按这个开始 · 3 个子会话」，下面一行一个，点了进那个子会话。 */
export function StartedRecord({ subs, onOpen }: { subs: SubSession[]; onOpen: (sub: SubSession) => void }) {
  return (
    <div className={h.started} data-testid="started-record">
      <p className={h.line}><StateIcon state="done" />{START_LABEL} · {subs.length} 个子会话</p>
      <ul>
        {subs.map((sub) => (
          <li key={sub.id}><button type="button" onClick={() => onOpen(sub)}><StateIcon state={sub.state} />{sub.title}</button></li>
        ))}
      </ul>
    </div>
  );
}
