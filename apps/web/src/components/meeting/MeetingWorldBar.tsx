"use client";

/**
 * 会议页页头下面一行（会前会后都在，回流设计稿 3.1、FR-4.1/4.2）：这场会挂到哪些对象、会议记录写进本体了没有、逐字稿读到哪了。
 * 主持人和 CEO 能「改」挂点（WorldAnchorPicker，可恢复自动）；会开完了，主持人、创建人和 CEO 看得到记录状态和逐字稿状态；
 * 参会人只看挂点；别人看不到这一行（GET /api/meetings/:id/world 给 404）。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { TMeetingRecordStatus, TMeetingWorldResponse, TMeetingWorldView, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { listMeetingWorldAnchorOptions, setMeetingWorldAnchors, useMeetingWorld } from "./meetingDecisionApi";
import { WorldAnchorPicker } from "./WorldAnchorPicker";
import { WorldAnchors, type AnchorTone } from "./WorldAnchors";
import d from "./meeting-decisions.module.css";

const toneOf = (world: TMeetingWorldView): AnchorTone | undefined =>
  world.record === null ? undefined : world.record.status === "excluded" ? "off"
    : world.record.status === "committed" ? "ok" : world.record.status === "failed" ? "fail" : "wait";

const RECORD: Record<TMeetingRecordStatus, { text: string; tone: string }> = {
  pending: { text: "记录 · 待确认", tone: "wait" },
  committed: { text: "记录 · 已写入", tone: "done" },
  edit_pending: { text: "记录 · 修改待确认", tone: "wait" },
  excluded: { text: "记录 · 不写入", tone: "off" },
  failed: { text: "记录 · 写入失败", tone: "fail" },
};

/** 页头那一行：取「这场会在本体里」；看不到时不显示。`transcript` 是逐字稿状态（只给看得到记录状态的人）。 */
export function MeetingWorldSection({ meetingId, ended, transcript }: { meetingId: string; ended: boolean; transcript?: ReactNode }) {
  const [detail, setDetail] = useMeetingWorld(meetingId);
  return detail ? <MeetingWorldBar meetingId={meetingId} world={detail.world} ended={ended} onChange={setDetail} transcript={transcript} /> : null;
}

export function MeetingWorldBar({ meetingId, world: initial, ended, onChange, transcript }: {
  meetingId: string; world: TMeetingWorldView;
  /** 会开完了：才出记录状态、逐字稿状态，挂点上才带写入状态的小点。 */
  ended: boolean;
  onChange: (next: TMeetingWorldResponse) => void;
  transcript?: ReactNode;
}) {
  const [world, setWorld] = useState(initial);
  useEffect(() => setWorld(initial), [initial]);
  const [picking, setPicking] = useState(false);
  const [options, setOptions] = useState<TWorldAnchorOption[] | null>(null);
  const [chosen, setChosen] = useState<TWorldAnchor[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const settle = async (work: () => Promise<TMeetingWorldResponse>) => {
    setBusy(true); setError("");
    try {
      const next = await work();
      setWorld(next.world); onChange(next); setPicking(false);
    } catch { setError("没有保存"); }
    finally { setBusy(false); }
  };
  const openPicker = async () => {
    setPicking(true); setError(""); setChosen(world.anchors.filter((anchor) => anchor.kind !== "task" && anchor.kind !== "company"));
    if (!options) {
      try { setOptions(await listMeetingWorldAnchorOptions(meetingId)); }
      catch { setError("没有读到对象"); }
    }
  };
  const showStatus = ended && world.record !== null;
  const record = showStatus ? RECORD[world.record!.status] : null;

  return (
    <div className={d.worldBar}>
      <div className={d.worldLine}>
        <span className={d.worldLabel}>挂到</span>
        <WorldAnchors anchors={world.anchors} tone={showStatus ? toneOf(world) : undefined} />
        {world.canEdit && !picking && !world.excluded ? <button type="button" className={d.anchorEdit} disabled={busy} onClick={() => void openPicker()}>改</button> : null}
        {showStatus ? (
          <span className={d.worldEnd}>
            <span className={d.status} data-tone={record!.tone}
              title={world.record!.status === "committed" ? monthDayTime(world.at) : world.record!.status === "excluded" ? world.excludedBy ?? undefined : undefined}>{record!.text}</span>
            {transcript}
          </span>
        ) : null}
      </div>
      {picking ? (
        <div className={d.pickerPanel}>
          {options ? <WorldAnchorPicker options={options} value={chosen} onChange={setChosen} /> : null}
          <div className={d.actions}>
            {world.edited ? <button type="button" className={d.link} disabled={busy} onClick={() => void settle(() => setMeetingWorldAnchors(meetingId, null))}>恢复自动</button> : null}
            <span className={d.spacer} />
            <button type="button" className={d.ghost} disabled={busy} onClick={() => setPicking(false)}>取消</button>
            <button type="button" className={d.primary} disabled={busy || !chosen.length}
              onClick={() => void settle(() => setMeetingWorldAnchors(meetingId, chosen.map(({ kind, id }) => ({ kind: kind as TWorldAnchorOption["kind"], id }))))}>保存</button>
          </div>
        </div>
      ) : null}
      {error ? <p className={d.worldError} role="alert">{error}</p> : null}
    </div>
  );
}
