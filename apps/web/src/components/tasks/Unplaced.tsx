"use client";

/**
 * 待归位（10/26）：会后分派、外部 Agent 建的执行事项没挂到 Mission 时，本人在这里处理——挑一个 Mission 挂上，
 * 或确认「不属于任何 Mission」并写一句为什么。事项详情页标题上方、首页「待归位」一组都用 UnplacedActions；
 * 通知栏用 unplacedNotices（挂到哪个要挑，点「挂到…」进事项详情）。办完发 member-tasks-changed，首页和通知栏重取。
 */
import { useState } from "react";
import type { TTaskView } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { Select } from "@/components/ui/Select";
import type { ActionNotice } from "@/components/ActionNoticeCard";
import type { NoticeOutcome } from "@/components/NoticeActions";
import u from "./unplaced.module.css";

type Task = Pick<TTaskView, "id" | "version" | "title" | "origin" | "unplaced" | "source">;
type MissionOption = { missionId: string; title: string };

const changed = () => window.dispatchEvent(new Event("member-tasks-changed"));

/** 小字：从哪来 · 为什么没挂上。 */
export function unplacedLine(task: Task): string {
  const from = task.origin ? `「${task.origin.meetingTitle}」分配给你` : "外部工具建的";
  return `${from} · ${task.unplaced?.reason ?? "还没挂到 Mission"}`;
}

export async function attachTask(task: Task, missionId: string): Promise<string | null> {
  try {
    const { data, error } = await browserApi.PATCH("/api/me/tasks/{id}", { params: { path: { id: task.id } }, body: { version: task.version, missionId } });
    if (data) { changed(); return null; }
    return error?.message ?? "没挂上，请重试";
  } catch { return "没挂上，网络断了"; }
}

export async function standaloneTask(task: Task, reason: string): Promise<string | null> {
  try {
    const { data, error } = await browserApi.POST("/api/me/tasks/{id}/standalone", { params: { path: { id: task.id } }, body: { version: task.version, reason } });
    if (data) { changed(); return null; }
    return error?.message ?? "没存上，请重试";
  } catch { return "没存上，网络断了"; }
}

/** 通知栏「待归位」一条：点标题或「挂到…」进事项详情挑 Mission；「不属于任何 Mission」在卡上写一句就办完。 */
export function unplacedNotices(tasks: Task[], open: (id: string, from: Element | null) => void): ActionNotice[] {
  return tasks.map((task) => ({
    id: `unplaced:${task.id}`,
    title: task.title,
    detail: unplacedLine(task),
    tone: "amber",
    onOpen: (from) => open(task.id, from),
    buttons: [{ label: "挂到…", emphasis: true, run: async (): Promise<NoticeOutcome> => { open(task.id, null); return { ok: false, cancelled: true }; } }],
    reason: {
      label: "不属于任何 Mission",
      fieldLabel: "为什么不属于任何 Mission",
      placeholder: "比如：一次性的调研，和本月的 Mission 都无关",
      submitLabel: "确认",
      run: async (reason) => {
        const failure = await standaloneTask(task, reason);
        return failure ? { ok: false, error: failure } : { ok: true, settled: "已确认不属于任何 Mission" };
      },
    },
  }));
}

/** 挑 Mission 挂上，或确认不属于任何 Mission。compact：首页列表里那一行，不写原因行。 */
export function UnplacedActions({ task, missions, compact = false, onDone }: { task: Task; missions: MissionOption[]; compact?: boolean; onDone?: () => void }) {
  const [missionId, setMissionId] = useState("");
  const [standalone, setStandalone] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true); setError("");
    const failure = await work();
    setBusy(false);
    if (failure) setError(failure);
    else onDone?.();
  };
  return (
    <div className={u.unplaced} data-unplaced data-compact={compact || undefined}>
      {compact ? null : <p className={u.line}>没挂到 Mission<span> · {task.unplaced?.reason ?? (task.origin ? `来自「${task.origin.meetingTitle}」` : "外部工具建的")}</span></p>}
      {standalone ? (
        <form className={u.row} onSubmit={(event) => { event.preventDefault(); if (reason.trim()) void run(() => standaloneTask(task, reason.trim())); }}>
          <input className={u.reason} aria-label="为什么不属于任何 Mission" placeholder="为什么不属于任何 Mission" value={reason} maxLength={200}
            disabled={busy} onChange={(event) => setReason(event.target.value)} autoFocus />
          <button type="submit" className={u.primary} disabled={busy || !reason.trim()}>确认</button>
          <button type="button" className={u.quiet} disabled={busy} onClick={() => { setStandalone(false); setError(""); }}>取消</button>
        </form>
      ) : (
        <div className={u.row}>
          {missions.length ? <>
            <Select aria-label="挂到哪个 Mission" placeholder="挂到哪个 Mission" size="compact" className={u.select} value={missionId}
              options={missions.map((mission) => ({ value: mission.missionId, label: mission.title }))} onChange={setMissionId} disabled={busy} />
            <button type="button" className={u.primary} disabled={busy || !missionId} onClick={() => void run(() => attachTask(task, missionId))}>挂上</button>
          </> : null}
          <button type="button" className={u.quiet} disabled={busy} onClick={() => setStandalone(true)}>不属于任何 Mission</button>
        </div>
      )}
      {error ? <p className={u.error} role="alert">{error}</p> : null}
    </div>
  );
}
