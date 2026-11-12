"use client";

/**
 * 「请这台电脑停掉」（17.4：伙伴的 stop_sub_session，在跑的子会话只能在本人电脑上停）：
 * 连着本机程序的网页每隔一阵认领这台电脑上的（POST /api/me/session-stops/claim），在跑的、排着的让本机停掉，再报结果（stopped / not_running）。
 * 本机已经没有这个会话、或已经停了的直接报 not_running；本机停不掉的不报，5 分钟后云端让别处（或下一次）重新认领。
 */
import { useEffect, useRef } from "react";
import type { LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { running } from "@/lib/local/sessionView";
import { claimSessionStops, reportSessionStop } from "./actions";

export const STOP_POLL_MS = 15_000;

/** 认领到的一条：在跑的、排着的（排着的停掉就是撤出队列，前面的卡做完也不再自己开工）请本机停掉，报 stopped。 */
export async function settleSessionStop(stop: { id: string; sessionId: string }, deviceId: string, local: Pick<LocalRunnerState, "runner" | "sessions">): Promise<void> {
  const session = local.sessions.find((entry) => entry.id === stop.sessionId);
  if (!session || !(running(session.status) || session.status === "queued")) { await reportSessionStop(stop.id, deviceId, "not_running").catch(() => undefined); return; }
  try { await local.runner.kill(stop.sessionId); } catch { return; }
  await reportSessionStop(stop.id, deviceId, "stopped").catch(() => undefined);
}

export function useSessionStops(local: LocalRunnerState, enabled: boolean) {
  const deviceId = enabled ? local.status?.deviceId ?? null : null;
  const ref = useRef(local);
  ref.current = local;
  useEffect(() => {
    if (!deviceId) return;
    let busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try {
        const stops = await claimSessionStops(deviceId);
        for (const stop of stops) await settleSessionStop(stop, deviceId, ref.current);
        if (stops.length) await ref.current.refresh();
      } catch { /* 认领不到（接口没上、断网）下一次再来 */ } finally { busy = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), STOP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [deviceId]);
}
