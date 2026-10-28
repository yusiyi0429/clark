import type { Pool } from "pg";
import { getMeetingRow } from "./meetingStore.js";
import { collectMeetingEvidence, evidenceVersions } from "./meetingEvidence.js";
import { startPreflight, type PreflightAgent } from "./meetingPreflight.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { personDisplayNames } from "./people.js";
import { computeStaleInputs } from "./preflightStaleness.js";

/**
 * 会议材料变了就按最新材料重跑预审（v5，10/28）：会议群里上传、删除、恢复、采纳修改之后，等这么久没有新改动再跑一次，
 * 连传几份只跑一次。不用人去点「重新预审」。
 * 跑之前再看一眼：会已经开完或取消了不跑；改动之后才开始的那次预审已经读到了这些材料，不跑；
 * 已完成的预审用到的材料版本和现在一致（例如有人已经手动重新预审过），不跑。只看材料，群讨论有新消息不触发。
 */
export const PREFLIGHT_RERUN_DELAY_MS = 8_000;

type RerunDeps = { pool: Pool; peopleDirectory: PeopleDirectory; preflightAgent: PreflightAgent };
const pending = new Map<string, { timer: NodeJS.Timeout; changedAt: number; deps: RerunDeps }>();

export function schedulePreflightRerun(deps: RerunDeps, meetingId: string): void {
  const previous = pending.get(meetingId);
  if (previous) clearTimeout(previous.timer);
  const changedAt = Date.now();
  const timer = setTimeout(() => void fire(meetingId), PREFLIGHT_RERUN_DELAY_MS);
  timer.unref();
  pending.set(meetingId, { timer, changedAt, deps });
}

/** 立即跑完所有等着的重跑（测试用，不等防抖时间）。 */
export async function flushPreflightReruns(): Promise<void> {
  const ids = [...pending.keys()];
  for (const id of ids) clearTimeout(pending.get(id)!.timer);
  await Promise.all(ids.map(fire));
}

async function fire(meetingId: string): Promise<void> {
  const item = pending.get(meetingId);
  if (!item) return;
  pending.delete(meetingId);
  try {
    await rerunIfMaterialsChanged(item.deps, meetingId, item.changedAt);
  } catch (error) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: "preflight.rerun_failed", meetingId, message: (error as Error)?.message }));
  }
}

async function rerunIfMaterialsChanged({ pool, peopleDirectory, preflightAgent }: RerunDeps, meetingId: string, changedAt: number): Promise<void> {
  const q = pool.query.bind(pool);
  const meeting = await getMeetingRow(q, meetingId);
  if (!meeting || meeting.status !== "scheduled" || meeting.ended_at) return;
  const { preflight } = meeting;
  if (preflight.status === "running" && preflight.pendingSince && Date.parse(preflight.pendingSince) >= changedAt) return;
  if (preflight.status === "ready") {
    const names = personDisplayNames(peopleDirectory);
    const viewer = { personId: meeting.ceo_participant_id, role: "ceo" as const, displayName: names.get(meeting.ceo_participant_id) ?? meeting.ceo_participant_id };
    const current = await collectMeetingEvidence(q, meetingId, viewer, { names, withContent: false });
    const stale = current ? computeStaleInputs(preflight.inputCoverage?.evidence, evidenceVersions(current)) : null;
    if (!stale?.materials.length) return;
  }
  await startPreflight(pool, peopleDirectory, preflightAgent, meetingId);
}
