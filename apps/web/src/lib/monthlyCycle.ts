"use client";

/**
 * 月度经营周期的总倒计时（72 小时，从个人复盘开始收集到签发下月全部任务卡）。
 * 全流程只有这一个倒计时：各阶段不另起计时，进入任务卡讨论也不重置；到期后继续累计超时。
 * 通知栏、任务卡页等多处同时显示，共用一份数据：每分钟、回到前台、复盘或任务卡有变动时重读。
 */
import { useEffect, useState } from "react";
import type { TMonthlyCycle } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

type Snapshot = { cycle: TMonthlyCycle | null; offset: number };
let snapshot: Snapshot = { cycle: null, offset: 0 };
const listeners = new Set<(value: Snapshot) => void>();
let timer: number | undefined;

async function load() {
  try {
    const { data } = await browserApi.GET("/api/monthly-cycle");
    if (!data) return;
    snapshot = { cycle: data.cycle, offset: data.cycle ? Date.parse(data.cycle.serverNow) - Date.now() : 0 };
    listeners.forEach((listener) => listener(snapshot));
  } catch { /* 下次再取 */ }
}
const refresh = () => { if (document.visibilityState === "visible") void load(); };

function subscribe(listener: (value: Snapshot) => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void load();
    timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("monthly-review-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    window.clearInterval(timer);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("monthly-review-changed", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

/** 当前周期与按服务端校正过的「现在」（每 30 秒走一次）。 */
export function useMonthlyCycle(): { cycle: TMonthlyCycle | null; now: number } {
  const [state, setState] = useState(snapshot);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => subscribe(setState), []);
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return { cycle: state.cycle, now: tick + state.offset };
}

const STAGE: Record<TMonthlyCycle["stage"], string> = {
  personal_reviews: "收集个人复盘",
  unit_reviews: "战场复盘",
  company_summary: "公司复盘",
  lto_decision: "LTO 审视",
  period_plan: "制定 PO",
  mission_cards: "任务卡讨论",
  done: "已签发",
};
export const cycleStageText = (cycle: TMonthlyCycle) => STAGE[cycle.stage];

const span = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分` : minutes ? `${minutes} 分` : "不到 1 分";
};

/** 「剩 47 小时 12 分」「已超时 5 小时 3 分」「用时 61 小时 20 分」。 */
export function cycleClock(cycle: TMonthlyCycle, now: number): { text: string; overdue: boolean; done: boolean; share: number } {
  const start = Date.parse(cycle.startedAt);
  const deadline = Date.parse(cycle.deadlineAt);
  if (cycle.completedAt) return { text: `用时 ${span(Date.parse(cycle.completedAt) - start)}`, overdue: Date.parse(cycle.completedAt) > deadline, done: true, share: 0 };
  const left = deadline - now;
  if (left <= 0) return { text: `已超时 ${span(-left)}`, overdue: true, done: false, share: 0 };
  return { text: `剩 ${span(left)}`, overdue: false, done: false, share: Math.min(1, left / (deadline - start)) };
}
