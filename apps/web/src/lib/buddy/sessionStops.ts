"use client";

/**
 * 「请这台电脑停掉」（17.4：伙伴的 stop_sub_session，在跑的子会话只能在本人电脑上停）：
 * 连着本机程序的网页每隔一阵认领这台电脑上的（POST /api/me/session-stops/claim），在跑的让本机停掉，再报结果（stopped / not_running）。
 * 本机已经没在跑的直接报 not_running；本机停不掉的不报，5 分钟后云端让别处（或下一次）重新认领。
 */
import { useEffect, useRef } from "react";
import type { LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { running } from "@/lib/local/sessionView";
import { claimSessionStops, reportSessionStop } from "./actions";

export const STOP_POLL_MS = 15_000;

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
        for (const stop of stops) {
          const { runner, sessions } = ref.current;
          const session = sessions.find((entry) => entry.id === stop.sessionId);
          if (!session || !running(session.status)) { await reportSessionStop(stop.id, deviceId, "not_running").catch(() => undefined); continue; }
          try { await runner.kill(stop.sessionId); } catch { continue; }
          await reportSessionStop(stop.id, deviceId, "stopped").catch(() => undefined);
        }
        if (stops.length) await ref.current.refresh();
      } catch { /* 认领不到（接口没上、断网）下一次再来 */ } finally { busy = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), STOP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [deviceId]);
}
