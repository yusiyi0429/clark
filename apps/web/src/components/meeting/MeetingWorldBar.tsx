"use client";

/**
 * 会议页「会上定了」头部的一条（回流设计稿 3.1）：这场会挂到哪些对象、写进本体了没有、不写进本体开关。
 * 主持人和 CEO 能「改」挂点（本月 Mission、责任单元，可恢复自动）、开关不写进本体；参会人只看挂点。
 */
import { useEffect, useMemo, useState } from "react";
import type { TMeetingWorldView, TWorldAnchor } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { listMeetingWorldAnchorOptions, setMeetingWorldAnchors, setMeetingWorldExcluded } from "./meetingDecisionApi";
import { WorldAnchors, type AnchorTone } from "./WorldAnchors";
import s from "@/styles/meeting-workspace.module.css";
import d from "./meeting-decisions.module.css";

const toneOf = (world: TMeetingWorldView): AnchorTone | undefined =>
  world.status === null ? undefined : world.excluded ? "off"
    : world.status === "committed" ? "ok" : world.status === "skipped" ? "miss" : world.status === "failed" ? "fail" : "wait";

function statusPill(world: TMeetingWorldView): { text: string; tone: string } | null {
  if (world.status === null) return null;
  if (world.excluded) return { text: [world.excludedBy, world.status === "withdrawn" ? "已撤回" : null].filter(Boolean).join(" · ") || "不写", tone: "off" };
  if (world.status === "committed") return { text: `已记 · ${monthDayTime(world.at)}`, tone: "done" };
  if (world.status === "skipped") return { text: "没对上", tone: "agent" };
  if (world.status === "failed") return { text: "写入失败", tone: "fail" };
  return { text: "待写入", tone: "wait" };
}

type AnchorKey = Pick<TWorldAnchor, "kind" | "id">;
const sameAnchor = (a: AnchorKey, b: AnchorKey) => a.kind === b.kind && a.id === b.id;

export function MeetingWorldBar({ meetingId, world: initial, onChange }: { meetingId: string; world: TMeetingWorldView; onChange: (world: TMeetingWorldView) => void }) {
  const [world, setWorld] = useState(initial);
  useEffect(() => setWorld(initial), [initial]);
  const [picking, setPicking] = useState(false);
  const [options, setOptions] = useState<TWorldAnchor[] | null>(null);
  const [chosen, setChosen] = useState<TWorldAnchor[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const settle = async (work: () => Promise<TMeetingWorldView>) => {
    setBusy(true); setError("");
    try {
      const next = await work();
      setWorld(next); onChange(next); setPicking(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const openPicker = async () => {
    setPicking(true); setQuery(""); setChosen(world.anchors.filter((anchor) => anchor.kind === "mission" || anchor.kind === "unit"));
    if (!options) {
      try { setOptions(await listMeetingWorldAnchorOptions(meetingId)); }
      catch (cause) { setError((cause as Error).message); }
    }
  };
  const shown = useMemo(() => (options ?? []).filter((option) => !query.trim() || option.title.toLowerCase().includes(query.trim().toLowerCase())), [options, query]);
  const toggle = (option: TWorldAnchor) => setChosen((current) => current.some((item) => sameAnchor(item, option)) ? current.filter((item) => !sameAnchor(item, option)) : [...current, option]);
  const pill = statusPill(world);

  return (
    <div className={d.worldBar}>
      <div className={d.worldLine}>
        <span className={d.worldLabel}>挂到</span>
        <WorldAnchors anchors={picking ? chosen : world.anchors} tone={picking ? undefined : toneOf(world)} onRemove={picking ? toggle : undefined} />
        {world.canEdit && !picking && !world.excluded ? <button type="button" className={d.anchorEdit} disabled={busy} onClick={() => void openPicker()}>改</button> : null}
        <span className={d.worldEnd}>
          {pill ? <span className={d.status} data-tone={pill.tone}>{pill.text}</span> : null}
          {world.canEdit ? (
            <button type="button" role="switch" aria-checked={world.excluded} className={d.switchRow} disabled={busy}
              onClick={() => void settle(() => setMeetingWorldExcluded(meetingId, !world.excluded))}>
              <span className={d.switch} data-on={world.excluded} aria-hidden="true"><span /></span>不写进本体
            </button>
          ) : null}
        </span>
      </div>
      {picking ? (
        <div className={d.picker}>
          <input aria-label="搜对象" placeholder="搜 Mission、单元" value={query} onChange={(event) => setQuery(event.target.value)} />
          <ul className={d.pickList}>
            {shown.map((option) => (
              <li key={`${option.kind}:${option.id}`}>
                <button type="button" className={d.pickOption} aria-pressed={chosen.some((item) => sameAnchor(item, option))} onClick={() => toggle(option)}>
                  <WorldAnchors anchors={[option]} />
                </button>
              </li>
            ))}
          </ul>
          <div className={d.actions}>
            {world.edited ? <button type="button" className={d.link} disabled={busy} onClick={() => void settle(() => setMeetingWorldAnchors(meetingId, null))}>恢复自动</button> : null}
            <span className={d.spacer} />
            <button type="button" className={d.ghost} disabled={busy} onClick={() => setPicking(false)}>取消</button>
            <button type="button" className={d.primary} disabled={busy || !chosen.length}
              onClick={() => void settle(() => setMeetingWorldAnchors(meetingId, chosen.map(({ kind, id }) => ({ kind: kind as "mission" | "unit", id }))))}>保存</button>
          </div>
        </div>
      ) : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}
    </div>
  );
}
