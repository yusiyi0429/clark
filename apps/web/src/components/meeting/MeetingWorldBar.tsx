"use client";

/**
 * 会议页页头下面那一块（会前会后都在，回流设计稿 3.1、FR-4.1）：第一行靠左是这场会挂到哪些对象，后面紧跟一个「改」；
 * 下面一行是进度线（`progress`，MeetingProgress）。写进本体的同步状态只在会议卡底部那一行，这里不重复。
 * 主持人和建会的人能「改」挂点（WorldAnchorPicker，可恢复自动）；参会人只看挂点；别人看不到挂点（GET /api/meetings/:id/world 给 404），只剩进度线。
 */
import { useEffect, useState, type ReactNode } from "react";
import type { TMeetingWorldResponse, TMeetingWorldView, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { listMeetingWorldAnchorOptions, setMeetingWorldAnchors, useMeetingWorld } from "./meetingDecisionApi";
import { WorldAnchorPicker } from "./WorldAnchorPicker";
import { WorldAnchors } from "./WorldAnchors";
import d from "./meeting-decisions.module.css";

/** 页头那一块：取「这场会在本体里」；看不到挂点时只放进度线。 */
export function MeetingWorldSection({ meetingId, progress }: { meetingId: string; progress?: ReactNode }) {
  const [detail, setDetail] = useMeetingWorld(meetingId);
  if (detail) return <MeetingWorldBar meetingId={meetingId} world={detail.world} onChange={setDetail} progress={progress} />;
  return progress ? <div className={d.worldBar}>{progress}</div> : null;
}

export function MeetingWorldBar({ meetingId, world: initial, onChange, progress }: {
  meetingId: string; world: TMeetingWorldView;
  onChange: (next: TMeetingWorldResponse) => void;
  progress?: ReactNode;
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

  return (
    <div className={d.worldBar}>
      <div className={d.worldLine}>
        <span className={d.worldLabel}>挂到</span>
        <WorldAnchors anchors={world.anchors} />
        {world.canEdit && !picking && !world.excluded ? <button type="button" className={d.anchorEdit} disabled={busy} onClick={() => void openPicker()}>改</button> : null}
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
      {progress}
    </div>
  );
}
