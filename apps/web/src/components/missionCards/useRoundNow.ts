"use client";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

type Clock = { now: number; offset: number; serverTime: number; listeners: Set<() => void>; timer?: ReturnType<typeof setTimeout>; cleanup?: () => void };
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
export function useRoundNow(closesAt: string | null, serverNow: string, onDeadline?: () => void): number {
  const serverTime = Date.parse(serverNow);
  const deadlineCallback = useRef(onDeadline);
  const notifiedDeadline = useRef<string | null>(null);
  useEffect(() => { deadlineCallback.current = onDeadline; }, [onDeadline]);
  const subscribe = useCallback((listener: () => void) => {
    if (!closesAt) return () => {};
    let clock = clocks.get(closesAt);
    if (!clock) {
      clock = { now: serverTime, offset: serverTime - Date.now(), serverTime, listeners: new Set() };
      clocks.set(closesAt, clock);
      const current = clock;
      const focus = () => tick(closesAt, current);
      const visible = () => { if (document.visibilityState === "visible") focus(); };
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visible);
      clock.cleanup = () => { window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visible); };
    }
    // 通知与页头可能先后挂载或收到乱序响应；同一个旧投影只能校时一次。
    if (serverTime > clock.serverTime) {
      clock.serverTime = serverTime;
      clock.offset = serverTime - Date.now();
    }
    const current = clock;
    const notify = () => {
      listener();
      if (current.now >= Date.parse(closesAt) && notifiedDeadline.current !== closesAt && deadlineCallback.current) {
        notifiedDeadline.current = closesAt;
        deadlineCallback.current();
      }
    };
    clock.listeners.add(notify);
    tick(closesAt, clock);
    return () => {
      clock.listeners.delete(notify);
      if (!clock.listeners.size) { clearTimeout(clock.timer); clock.cleanup?.(); clocks.delete(closesAt); }
    };
  }, [closesAt, serverTime]);
  const snapshot = useCallback(() => closesAt ? clocks.get(closesAt)?.now ?? serverTime : serverTime, [closesAt, serverTime]);
  const now = useSyncExternalStore(subscribe, snapshot, () => serverTime);
  return now;
}
