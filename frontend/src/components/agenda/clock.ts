"use client";

import { useMemo, useSyncExternalStore } from "react";

import { readClock, type Clock } from "@/lib/data/agenda";

/**
 * 此刻，按北京时间算 —— 排会那几块屏幕唯一的时钟。
 *
 * ## 为什么服务端渲染那一帧一定是「还不知道」
 *
 * 「这场会开完没有」是一句和时刻有关的话，而服务端渲染那一帧的时刻和浏览器接手那一帧的
 * 时刻不是同一个 —— 直接算的话，跨过某一场会的结束时刻那一瞬间刷新页面，两边会渲染出
 * 不同的东西，hydration 当场报错。所以服务端那一帧一律返回 `null`，用它的地方按「还不知道」
 * 渲染（既不是开完也不是正在开）。差的那一帧是几毫秒。
 *
 * ## 为什么是 `useSyncExternalStore` 而不是 `useEffect` + `setState`
 *
 * 墙上的时钟正是这个 hook 说的那种「外部数据源」：它自己会变，React 只是订阅它。写成
 * effect 里 setState 的话，每一次挂载都会多一轮渲染，而这一屏上挂着这个 hook 的组件有
 * 好几个 —— 那是一串本来不必发生的级联渲染（`react-hooks/set-state-in-effect` 挡的就是它）。
 *
 * 快照是一个**字符串**，不是对象：`getSnapshot` 必须每次返回同一个引用，返回新对象会让
 * React 认为数据一直在变，于是无限重渲染。
 *
 * ## 为什么每分钟对一次表
 *
 * 他可能开着这一屏坐在会议室里。散会那一刻屏幕上要自己出现「传录音」，而不是等他刷新 ——
 * 一个要靠刷新才更新的时间判断，和写死一个时间没有区别。一分钟一次：这里所有的判断都
 * 只精确到分钟，更密的心跳换不到任何东西。
 */
/*
 * 表本身在 `lib/data/agenda.ts` 上 —— 这个文件是 `"use client"`，数据层进不去，而
 * 「这场会过去了没有」两侧都要算。两份实现只要差一分钟的取整，屏幕上就会出现「这一栏说
 * 它过去了、那一栏说还没有」，两栏都不报错。这里只负责把它接成一个会自己走的 hook。
 */
export type { Clock } from "@/lib/data/agenda";

/** 快照的形状：`2026-08-30T870`。字符串才能保证同一分钟内返回同一个值。 */
const stamp = (): string => {
  const c = readClock();
  return `${c.day}T${c.minutes}`;
};

let snapshot = "";
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const tick = () => {
  const next = stamp();
  if (next === snapshot) return;
  snapshot = next;
  for (const l of listeners) l();
};

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  // 第一个订阅者把表开起来，最后一个走的时候关掉 —— 没人看的时候不留一个每分钟醒一次的定时器。
  if (!timer) timer = setInterval(tick, 60_000);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = (): string => {
  if (!snapshot) snapshot = stamp();
  return snapshot;
};

/** 服务端那一帧：空串 = 还不知道现在几点。理由见文件头。 */
const getServerSnapshot = (): string => "";

export function useClock(): Clock | null {
  const s = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(() => {
    if (!s) return null;
    const [day, minutes] = s.split("T");
    return { day, minutes: Number(minutes) };
  }, [s]);
}
