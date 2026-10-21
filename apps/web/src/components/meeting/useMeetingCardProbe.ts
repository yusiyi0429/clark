"use client";

import { useEffect, useRef, useState } from "react";
import type { TMeetingCardView } from "@warmap/contracts";
import { readMeetingCard } from "./useMeetingCard";

type Probe = { meetingId: string; status: "legacy"; refreshKey: string } | { meetingId: string; status: "card"; view: TMeetingCardView };
export type CardProbe = { status: "unknown" | "legacy" } | { status: "card"; initial: TMeetingCardView; remember: (view: TMeetingCardView) => void };
const UNKNOWN: CardProbe = { status: "unknown" };
const LEGACY: CardProbe = { status: "legacy" };

/**
 * 会议记录这块用会议卡还是旧格式的会后条目：问会议卡接口，有草稿或确认版就是会议卡；还没问到时 unknown（这块先什么都不放）。
 * 问到是会议卡以后不再问（确认后会议状态变了，会议卡也不重新挂载）；unknown、legacy 时 refreshKey 变了再问（会后整理刚生成了草稿），
 * 再问的这一会儿算 unknown：不先闪一下旧格式的空纪要，再换成会议卡。
 * 会议卡交回来的最新视图记在这里（remember）：切到别的视图再切回来，会议卡从最新的接着显示。
 */
export function useMeetingCardProbe(meetingId: string, refreshKey: string): CardProbe {
  const [probe, setProbe] = useState<Probe | null>(null);
  const latest = useRef<{ meetingId: string; view: TMeetingCardView } | null>(null);
  const current = probe?.meetingId === meetingId ? probe : null;
  const isCard = current?.status === "card";
  useEffect(() => {
    if (isCard) return;
    let live = true;
    void readMeetingCard(meetingId).then((result) => {
      if (!live) return;
      setProbe(result.ok && (result.view.draft || result.view.confirmed) ? { meetingId, status: "card", view: result.view } : { meetingId, status: "legacy", refreshKey });
    });
    return () => { live = false; };
  }, [meetingId, refreshKey, isCard]);
  if (!current) return UNKNOWN;
  if (current.status === "legacy") return current.refreshKey === refreshKey ? LEGACY : UNKNOWN;
  return {
    status: "card",
    initial: latest.current?.meetingId === meetingId ? latest.current.view : current.view,
    remember: (view) => { latest.current = { meetingId, view }; },
  };
}
