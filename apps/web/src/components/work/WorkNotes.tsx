"use client";

/**
 * 伙伴另外说的一句（V2 设计第 20.3 节，只有三种，样子照 prototype-home），由网页按时间插进对话：
 * 验收过了或没过、岗位修改建议、这一单全部完成。等你的事不单出一句（在左栏和派活单的行里）；逐步的进展也不往对话里刷。只出最近一天的。
 */
import { useState, type ReactNode } from "react";
import { HeroButton } from "@/components/HeroButton";
import { showWorkspaceToast } from "@/lib/toast";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { FIELD_LABEL, decideProposal, type RoleProposalView } from "@/lib/team/roles";
import { overruleWorker } from "@/lib/work/actions";
import type { Worker } from "@/lib/work/workers";
import { Chain, RoleAvatar } from "./WorkerRow";
import type { TimedBlock } from "./WorkTimeline";
import w from "@/styles/v2-work.module.css";

const DAY_MS = 86_400_000;

export type NoteHandlers = { openWorker: (cardId: string) => void; openTask: (taskId: string) => void; changed: () => void };

/** 改后比改前多出来的行（建议里新加的那句）；没有新行就是整段。 */
export function addedLines(before: string, after: string): string {
  const old = new Set(before.split("\n").map((line) => line.trim()));
  const added = after.split("\n").filter((line) => line.trim() && !old.has(line.trim()));
  return (added.length ? added : after.split("\n")).join("\n").trim();
}

export function workNotes({ workers, tasks, boards, proposals, now, on }: {
  workers: Worker[];
  tasks: { taskId: string; name: string }[];
  boards: Record<string, TaskBoard>;
  proposals: RoleProposalView[];
  now: number;
  on: NoteHandlers;
}): TimedBlock[] {
  const notes: TimedBlock[] = [];
  for (const worker of workers) {
    const handback = worker.item?.card?.handback;
    if (handback?.status !== "done" || !handback.outcome || !handback.finishedAt) continue;
    notes.push({ key: `accept:${handback.id}`, at: handback.finishedAt, node: <AcceptanceNote worker={worker} on={on} /> });
  }
  for (const proposal of proposals) notes.push({ key: `proposal:${proposal.id}`, at: proposal.createdAt, node: <ProposalNote proposal={proposal} onChanged={on.changed} /> });
  for (const task of tasks) {
    const mine = workers.filter((worker) => worker.taskId === task.taskId);
    if (!mine.length || mine.some((worker) => worker.state !== "done")) continue;
    const at = mine.map((worker) => worker.endedAt ?? "").sort().pop();
    if (!at) continue;
    const board = boards[task.taskId];
    const ready = board?.pending.length ? `v${board.nextVersion}` : null;
    notes.push({ key: `done:${task.taskId}:${at}`, at, node: (
      <Note testId="note-done" lead={<Chain state="done" />}>
        <div>「{task.name}」这一单 {mine.length} 件都完成了{ready ? `，${ready} 可以交了` : ""}。</div>
        <div className={w.acts}><HeroButton variant="primary" size="sm" onPress={() => on.openTask(task.taskId)}>{ready ? `看 ${ready}` : "看交付物"}</HeroButton></div>
      </Note>
    ) });
  }
  return notes.filter((note) => now - Date.parse(note.at) < DAY_MS);
}

function Note({ testId, lead, children }: { testId: string; lead: ReactNode; children: ReactNode }) {
  return <div className={w.note} data-testid={testId}>{lead}<div className={w.tx}>{children}</div></div>;
}

/** 验收过了：「验收员：『标题』2/2 达到，已攒进 v2。」看看、推翻；没过：仍然通过。推翻、仍然通过都要写原因。 */
function AcceptanceNote({ worker, on }: { worker: Worker; on: NoteHandlers }) {
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handback = worker.item!.card!.handback!;
  const pass = handback.outcome === "pass";
  const inclusion = worker.item!.card?.deliverable;
  const submit = async () => {
    if (!reason?.trim()) return;
    setBusy(true);
    try { await overruleWorker(worker, reason.trim()); showWorkspaceToast({ text: pass ? "已推翻，回到进行中" : "已算通过" }); setReason(null); on.changed(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
    finally { setBusy(false); }
  };
  return (
    <Note testId="note-acceptance" lead={<Chain state={pass ? "done" : "queued"} />}>
      <div><b>验收员</b>：「{worker.title}」{handback.met}/{handback.total} 达到{pass ? (inclusion ? `，已攒进 v${inclusion.versionNumber}` : "") : `，没过${handback.headline ? `：${handback.headline}` : ""}`}。</div>
      {handback.overruled ? <div className={w.m}>已推翻</div> : reason !== null ? (
        <form className={w.acts} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <span className={w.inline}><input autoFocus value={reason} maxLength={200} placeholder="原因" aria-label={pass ? "推翻的原因" : "仍然通过的原因"} onChange={(event) => setReason(event.target.value)} /></span>
          <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !reason.trim()}>{pass ? "推翻" : "仍然通过"}</HeroButton>
          <HeroButton variant="ghost" size="sm" onPress={() => setReason(null)}>取消</HeroButton>
        </form>
      ) : (
        <div className={w.acts}>
          <HeroButton variant="secondary" size="sm" onPress={() => on.openWorker(worker.key)}>看看</HeroButton>
          {pass && inclusion?.state === "included" ? null : <HeroButton variant="ghost" size="sm" onPress={() => setReason("")}>{pass ? "推翻" : "仍然通过"}</HeroButton>}
        </div>
      )}
    </Note>
  );
}

function ProposalNote({ proposal, onChanged }: { proposal: RoleProposalView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "accept" | "dismiss") => {
    setBusy(true);
    try { await decideProposal(proposal.id, decision); showWorkspaceToast({ text: decision === "accept" ? `已写进「${proposal.role.name}」` : "已丢掉" }); onChanged(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
    finally { setBusy(false); }
  };
  return (
    <Note testId="note-proposal" lead={<RoleAvatar name={proposal.role.name} kind={proposal.role.kind} />}>
      <div><b>{proposal.role.name}</b>的{FIELD_LABEL[proposal.field]}改一句</div>
      <blockquote>{addedLines(proposal.currentText, proposal.proposedText)}</blockquote>
      <div className={w.m}>{proposal.sourceKind === "overrule" ? `因为你推翻了「${proposal.card.title}」的验收` : `因为「${proposal.card.title}」第二次没过`}</div>
      <div className={w.acts}>
        <HeroButton variant="primary" size="sm" isDisabled={busy} onPress={() => void decide("accept")}>采纳</HeroButton>
        <HeroButton variant="secondary" size="sm" isDisabled={busy} onPress={() => void decide("dismiss")}>不要</HeroButton>
      </div>
    </Note>
  );
}
