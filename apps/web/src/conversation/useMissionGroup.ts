"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mergeGroupEntries, type FeedbackRequest, type MissionGroupView, type MissionGroupReference, type PersonalMissionGroup } from "./missionCardGroup";
const CONNECTION_ERROR = "群组暂时没有连接成功，输入仍会保留。";

export function useMissionGroup(group: PersonalMissionGroup | undefined, visible: boolean) {
  const [view, setView] = useState<MissionGroupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const pending = useRef<{ signature: string; clientId: string } | null>(null);
  const latest = useRef(group);
  latest.current = group;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const after = useRef(0);
  const cardId = group?.cardId;
  const phase = group?.phase;
  const round = group?.round;
  const reload = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!cardId) return;
    let active = true;
    let loading = false;
    let initialized = false;
    let markers = "";
    let roundVersion: number | null = null;
    after.current = 0;
    setView(null);
    const controller = new AbortController();
    const load = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const response = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/group?after=${after.current}`, { signal: controller.signal });
        if (!response.ok) throw new Error("群组暂时没有连接成功，请稍后再试。");
        let next = await response.json() as MissionGroupView;
        if (!active) return;
        const versionChanged = roundVersion !== null && next.roundVersion !== roundVersion;
        if (versionChanged && after.current > 0) {
          const full = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/group?after=0`, { signal: controller.signal });
          if (!full.ok) throw new Error(CONNECTION_ERROR);
          next = await full.json() as MissionGroupView;
          if (!active) return;
        }
        const highest = next.entries.reduce((seq, entry) => entry.type === "message" ? Math.max(seq, entry.feedback.seq) : seq, after.current);
        const changed = highest > after.current;
        const nextMarkers = JSON.stringify(next.entries.filter((entry) => entry.type !== "message"));
        after.current = highest;
        setView((previous) => ({ ...next, entries: mergeGroupEntries(previous?.entries ?? [], next.entries) }));
        setError((current) => current === CONNECTION_ERROR ? null : current);
        if (!initialized || changed || versionChanged || nextMarkers !== markers) latest.current?.onRefresh();
        initialized = true;
        markers = nextMarkers;
        roundVersion = next.roundVersion;
        if (visibleRef.current && highest > next.lastReadSeq) {
          const read = await fetch(`/api/mission-cards/${encodeURIComponent(cardId)}/group/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lastReadSeq: highest }), signal: controller.signal });
          if (read.ok && active) {
            const marked = await read.json() as { lastReadSeq: number; unread: number };
            if (active) setView((previous) => previous ? { ...previous, ...marked } : previous);
          }
        }
      } catch (cause) {
        if (active && !(cause instanceof Error && cause.name === "AbortError")) setError(CONNECTION_ERROR);
      } finally { loading = false; }
    };
    reload.current = load;
    void load();
    const timer = setInterval(() => { void load(); }, 3000);
    const resume = () => { void load(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => { active = false; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); };
  }, [cardId, phase, round]);

  useEffect(() => { if (visible) void reload.current(); }, [visible]);
  const send = useCallback(async (body: string, reference: MissionGroupReference | null): Promise<boolean> => {
    const current = latest.current;
    if (!current) return false;
    const input = { kind: reference ? "quote" : "comment", round: current.round, body, ...(reference ? { missionId: reference.missionId, field: reference.field, quote: reference.quote, sourceVersion: reference.sourceVersion } : {}) };
    const signature = JSON.stringify(input);
    if (pending.current?.signature !== signature) pending.current = { signature, clientId: crypto.randomUUID() };
    const payload: FeedbackRequest = { ...input, kind: reference ? "quote" : "comment", clientId: pending.current.clientId };
    setSending(true); setError(null);
    try {
      const response = await fetch(`/api/mission-cards/${encodeURIComponent(current.cardId)}/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({})) as { message?: string };
        if (response.status === 409) current.onRefresh();
        throw new Error(problem.message ?? "发送失败，输入仍会保留。");
      }
      pending.current = null;
      current.onRefresh();
      void reload.current();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "发送失败，输入仍会保留。"); return false; }
    finally { setSending(false); }
  }, []);
  return { view, error, sending, send };
}
