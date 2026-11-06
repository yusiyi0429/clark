"use client";

/**
 * 派活单（V2 设计第 20.3 节，样子照 prototype-home）：对话里一个 Task 的那一块，由网页按时间插进对话，不经过 Chat 服务。
 * - 拆卡在跑：已用 / 预计。
 * - 拆好了（待开工）：每行一个 worker，写岗位、要干的事、对约定第几条，右边模型（按岗位档位默认，点开能换）；「开工」「改一改」（改标题、换岗位、去掉一行）。
 *   没有岗位的是人自己的活，照样建成执行事项，不交给本机。
 * - 开工：在这台电脑上一次交给本机，同时最多 3 个，多的排队；手机上确认的排进「等开工」，回到电脑上页头有「开工 N 件」。
 * - 开工以后：页头是 Task、链路小点和数字、用时，点它展开或收起；收起时只留等你的行（带「要运行 …」和批准、拒绝）。点一行右栏打开详情。
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { TCardDraftView, THomePlanTask } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { readLast, writeLast } from "@/lib/local/start";
import type { TLocalModelProfile } from "@/lib/local/runner";
import { acceptDrafts, dismissDraft, planCards } from "@/lib/board/cloud";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { showWorkspaceToast } from "@/lib/toast";
import { TIER_LABEL, draftRole, modelForTier, type CardRole, type RoleView } from "@/lib/team/roles";
import { SLOT_CAP, startBatch, startedText, type StartPlan } from "@/lib/work/queue";
import { chainCounts, elapsed, liveSessions, type Worker } from "@/lib/work/workers";
import { ChainDots, Slots } from "./WorkPanel";
import { Chain, RoleAvatar, WorkerRow } from "./WorkerRow";
import w from "@/styles/v2-work.module.css";

/** 草稿行配的岗位：拆卡给的；没给时执行方是自己的为 null（人自己的活），否则写 Claude Code。 */
export function draftWorkerRole(draft: TCardDraftView): CardRole | null {
  return draftRole(draft) ?? (draft.executor === "self" ? null : { id: "", name: "Claude Code", kind: "worker" });
}

/** 「进行中 2 · 已排队 1 · 已完成 1」，是 0 的不写。 */
export function countsText(workers: Worker[]): string {
  const n = chainCounts(workers);
  return ([["进行中", n.doing], ["已排队", n.queued], ["已完成", n.done]] as const).filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(" · ");
}

export function DispatchBlock({ task, board, workers, roles, now, handheld, current, newest, onOpenWorker, onChanged }: {
  task: THomePlanTask;
  board: TaskBoard;
  workers: Worker[];
  roles: RoleView[];
  now: number;
  handheld: boolean;
  current: string | null;
  /** 最新的那一单默认展开。 */
  newest: boolean;
  onOpenWorker: (key: string) => void;
  onChanged: () => void;
}) {
  const planning = board.plan && (board.plan.status === "queued" || board.plan.status === "running") ? board.plan : null;
  return (
    <>
      {workers.length ? <Live task={task} workers={workers} now={now} current={current} newest={newest} onOpenWorker={onOpenWorker} onChanged={onChanged} /> : null}
      {planning ? (
        <section className={w.disp} aria-label={`拆卡：${task.name}`}>
          <div className={w.dispHead}><span className={w.tagd}>派活单</span><span className={w.ttl}>{task.name}</span><span className={w.sum}>正在拆</span>
            <span className={w.el}>{Math.max(0, Math.round((now - Date.parse(planning.startedAt ?? planning.createdAt)) / 1000))} 秒 / 预计 {planning.expectedSeconds} 秒</span></div>
        </section>
      ) : board.plan?.status === "failed" && !board.drafts.length ? (
        <section className={w.disp} aria-label={`拆卡：${task.name}`}>
          <div className={w.dispHead}><span className={w.tagd}>派活单</span><span className={w.ttl}>{task.name}</span><span className={w.sum}>没拆成</span><span className={w.grow} />
            <HeroButton variant="secondary" size="sm" onPress={() => void planCards(task.taskId).then(onChanged).catch((error) => showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }))}>重新拆</HeroButton></div>
        </section>
      ) : null}
      {board.drafts.length ? <Draft task={task} drafts={board.drafts} roles={roles} handheld={handheld} onChanged={onChanged} /> : null}
    </>
  );
}

const NEEDS_YOU = new Set(["approval", "reply", "review_failed"]);

function Live({ task, workers, now, current, newest, onOpenWorker, onChanged }: { task: THomePlanTask; workers: Worker[]; now: number; current: string | null; newest: boolean; onOpenWorker: (key: string) => void; onChanged: () => void }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? newest;
  const started = workers.map((worker) => worker.startedAt).filter((at): at is string => !!at).sort()[0] ?? null;
  const allDone = workers.every((worker) => worker.state === "done");
  const ended = allDone ? workers.map((worker) => worker.endedAt ?? "").sort().pop() || null : null;
  const order = { done: 0, doing: 1, queued: 2 } as const;
  const sorted = [...workers].sort((a, b) => order[a.state] - order[b.state]);
  const shown = expanded ? sorted : sorted.filter((worker) => worker.state === "doing" && worker.mark && NEEDS_YOU.has(worker.mark));
  const hidden = sorted.length - shown.length;
  return (
    <section className={w.disp} data-testid="dispatch-block" aria-label={`派活单：${task.name}`}>
      <div className={w.dispHead} role="button" tabIndex={0} aria-expanded={expanded} onClick={() => setOpen(!expanded)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(!expanded); } }}>
        <span className={w.tagd}>派活单</span>
        <span className={w.ttl}>{task.name}</span>
        <ChainDots workers={sorted} />
        <span className={w.sum}>{countsText(workers)}</span>
        {started ? <span className={w.el}>{elapsed(started, ended ?? now)}</span> : null}
      </div>
      {shown.map((worker) => <WorkerRow key={worker.key} worker={worker} now={now} current={current === worker.key} ask onOpen={() => onOpenWorker(worker.key)} onChanged={onChanged} />)}
      {hidden ? <button type="button" className={w.more} onClick={() => setOpen(true)}>其余 {hidden} 件</button> : null}
    </section>
  );
}

type Edit = { title?: string; role?: CardRole | null; modelId?: string; dropped?: boolean };

function Draft({ task, drafts, roles, handheld, onChanged }: { task: THomePlanTask; drafts: TCardDraftView[]; roles: RoleView[]; handheld: boolean; onChanged: () => void }) {
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
        showWorkspaceToast({ text: `${plans.length} 件等开工` });
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

  return (
    <section className={w.disp} data-testid="dispatch-draft" aria-label={`派活单：${task.name}`}>
      <div className={w.dispHead}><span className={w.tagd}>派活单</span><span className={w.ttl}>{task.name}</span><span className={w.sum}>{kept.length} 件 · 待开工</span></div>
      {kept.map((draft) => {
        const role = roleOf(draft);
        const model = modelOf(draft);
        const kind = roles.find((entry) => entry.id === role?.id)?.kind ?? "worker";
        return (
          <div key={draft.id} className={w.wr} data-draft data-testid="draft-row">
            <Chain state="draft" />
            <RoleAvatar name={role?.name ?? "我"} kind={role ? kind : "self"} />
            <div className={w.mid}>
              <div className={w.l1}>
                <span className={w.who}>{role?.name ?? "我自己"}</span>
                {editing ? <input value={edits[draft.id]?.title ?? draft.title} maxLength={120} aria-label="要干的事" onChange={(event) => edit(draft.id, { title: event.target.value })} />
                  : <span className={w.what} title={draft.title}>{edits[draft.id]?.title ?? draft.title}</span>}
              </div>
              {draft.criterionIndex ? <div className={w.l2}>约定第 {draft.criterionIndex} 条</div> : null}
            </div>
            <span className={w.acts}>
              {editing ? <>
                <Pick label={role?.name ?? "我自己"} options={[...workerRoles.map((entry) => ({ id: entry.id, label: entry.name })), { id: "self", label: "我自己" }]} value={role?.id || "self"}
                  onPick={(id) => edit(draft.id, { role: id === "self" ? null : { id, name: workerRoles.find((entry) => entry.id === id)!.name, kind: "worker" }, modelId: undefined })} />
                <button type="button" className={w.iconBtn} aria-label={`去掉「${draft.title}」`} onClick={() => edit(draft.id, { dropped: true })}><X size={14} aria-hidden /></button>
              </> : role ? (local.models.length ? <Pick label={model?.label ?? "模型"} options={local.models.map((entry) => ({ id: entry.id, label: entry.label }))} value={model?.id ?? ""} onPick={(id) => edit(draft.id, { modelId: id })} />
                : <span className={w.mchip}>{TIER_LABEL[tierOf(draft, role)]}</span>) : null}
            </span>
          </div>
        );
      })}
      <div className={w.dispFoot}>
        <HeroButton variant="primary" size="sm" isDisabled={busy || !kept.length || (ready && !folder)} onPress={() => void start()}>{busy ? "正在开工…" : "开工"}</HeroButton>
        <HeroButton variant="secondary" size="sm" isDisabled={busy} onPress={() => setEditing(!editing)}>{editing ? "改好了" : "改一改"}</HeroButton>
        <span className={w.grow} />
        {ready ? (folder ? <Pick label={folder.label} options={local.folders.map((entry) => ({ id: entry.id, label: entry.label }))} value={folder.id} onPick={setFolderId} up />
          : <button type="button" className={w.mchip} onClick={() => void local.pickFolder().then((picked) => { if (picked) setFolderId(picked.id); })}>选文件夹</button>) : null}
        <span className={w.rh}>本机 <Slots used={used} cap={SLOT_CAP} off={!ready} /> {used}/{SLOT_CAP}</span>
      </div>
    </section>
  );
}

/** 一个小下拉：点开列出选项。 */
function Pick({ label, options, value, onPick, up }: { label: string; options: { id: string; label: string }[]; value: string; onPick: (id: string) => void; up?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={w.pick}>
      <button type="button" className={w.mchip} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}<ChevronDown size={11} aria-hidden /></button>
      {open ? (
        <span className={w.menu} data-up={up || undefined} role="menu" onMouseLeave={() => setOpen(false)}>
          {options.map((option) => <button key={option.id || "none"} type="button" role="menuitemradio" aria-checked={option.id === value} onClick={() => { onPick(option.id); setOpen(false); }}>{option.label}</button>)}
        </span>
      ) : null}
    </span>
  );
}
