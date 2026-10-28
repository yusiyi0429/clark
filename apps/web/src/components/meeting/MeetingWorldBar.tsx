"use client";

/**
 * 会议页页头下面那一块（会前会后都在，回流设计稿 3.1、FR-4.1）：靠左写这场会挂到哪些对象（全文），后面紧跟一个「改」；
 * 进度线在它上面那一行，由 MeetingCard 自己放。写进本体的同步状态只在会议卡底部那一行，这里不重复。
 * 主持人和建会的人能「改」挂点（WorldAnchorPicker，可恢复自动）；参会人只看挂点；别人看不到挂点（GET /api/meetings/:id/world 给 404），这一行不出现。
 */
import { useEffect, useState } from "react";
import type { TMeetingWorldResponse, TMeetingWorldView, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { listMeetingWorldAnchorOptions, setMeetingWorldAnchors, useMeetingWorld } from "./meetingDecisionApi";
import { WorldAnchorPicker } from "./WorldAnchorPicker";
import { WorldAnchors } from "./WorldAnchors";
import d from "./meeting-decisions.module.css";

/** 页头那一块：取「这场会在本体里」；看不到挂点时不出现。 */
export function MeetingWorldSection({ meetingId, viewerId }: { meetingId: string; viewerId?: string }) {
  const [detail, setDetail] = useMeetingWorld(meetingId);
  return detail ? <MeetingWorldBar meetingId={meetingId} viewerId={viewerId} world={detail.world} onChange={setDetail} /> : null;
}

export function MeetingWorldBar({ meetingId, viewerId, world: initial, onChange }: {
  meetingId: string; world: TMeetingWorldView;
  /** 登录的人：挑挂点时自己的 Mission 列在最前。 */
  viewerId?: string;
  onChange: (next: TMeetingWorldResponse) => void;
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
        <span className={d.worldLabel}>所属</span>
        <WorldAnchors anchors={world.anchors} />
        {/* 「改」前面是一个普通空格（不是外边距）：折到下一行时空格被吃掉，「改」顶格、不缩进。 */}
        {world.canEdit && !picking && !world.excluded ? <>{" "}<button type="button" className={d.anchorEdit} disabled={busy} onClick={() => void openPicker()}>更换</button></> : null}
      </div>
      {picking ? (
        <div className={d.pickerPanel}>
          {options ? <WorldAnchorPicker options={options} value={chosen} onChange={setChosen} viewerId={viewerId} /> : null}
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
