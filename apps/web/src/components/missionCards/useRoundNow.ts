"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";

type Clock = { now: number; offset: number; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>; cleanup?: () => void };
const clocks = new Map<string, Clock>();

function tick(key: string, clock: Clock) {
  if (clock.timer) clearTimeout(clock.timer);
  clock.now = Date.now() + clock.offset;
  clock.listeners.forEach((listener) => listener());
  const remaining = Date.parse(key) - clock.now;
  // 对齐到截止时刻的秒位；越过截止仍每分钟对表，直到服务端投影进入下一阶段。
  const delay = remaining > 0 ? ((remaining % 60_000) || 60_000) + 20 : 60_000;
  clock.timer = setTimeout(() => tick(key, clock), delay);
}

/** 同一截止时刻只用一个分钟定时器；serverNow 校正本机时间，返回前台立即对表。
 * Windows 上避开与 RoundClock.tsx 仅大小写不同的 basename，防止模块解析混淆。 */
export function useRoundNow(closesAt: string | null, serverNow: string): number {
  const serverTime = Date.parse(serverNow);
  const subscribe = useCallback((listener: () => void) => {
    if (!closesAt) return () => {};
    let clock = clocks.get(closesAt);
    if (!clock) {
      clock = { now: serverTime, offset: serverTime - Date.now(), listeners: new Set() };
      clocks.set(closesAt, clock);
      const current = clock;
      const focus = () => tick(closesAt, current);
      const visible = () => { if (document.visibilityState === "visible") focus(); };
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visible);
      clock.cleanup = () => { window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
    }
    clock.listeners.add(listener);
    tick(closesAt, clock);
    return () => {
      clock.listeners.delete(listener);
      if (!clock.listeners.size) { clearTimeout(clock.timer); clock.cleanup?.(); clocks.delete(closesAt); }
    };
  }, [closesAt, serverTime]);
  const snapshot = useCallback(() => closesAt ? clocks.get(closesAt)?.now ?? serverTime : serverTime, [closesAt, serverTime]);
  const now = useSyncExternalStore(subscribe, snapshot, () => serverTime);
  useEffect(() => {
    const clock = closesAt ? clocks.get(closesAt) : undefined;
    if (clock && closesAt) { clock.offset = serverTime - Date.now(); tick(closesAt, clock); }
  }, [closesAt, serverTime]);
  return now;
}
