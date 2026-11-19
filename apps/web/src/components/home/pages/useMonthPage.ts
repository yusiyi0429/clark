"use client";

/**
 * 月份页的数据（设计 10.4、10.5、12.4），形状照 B2 的契约（packages/contracts/src/taskContinuity.ts）：
 * - GET  /api/me/months/:period → MonthPageData：这个月本人的每件 Task 和天枢备好的状态（Mission 的成果、完成标准原文和哪几条达到、验收时间点、去向、
 *   交付第几版、还在跑的、受阻的、本人确认完成没有、了结了没有（完成 / 到此为止 / 已延续，延续去了哪）、从哪件延续来的），以及下个月 Co-Agent 的草稿（暂为 null，等溪南）。
 *   第一版的复盘答案（PUT …/tasks/:taskId/decision）删了：去向和评定都在复盘页（useMonthReview）。
 * 接口还没有（404）时：开发和测试里用假数据（monthFixture），生产里写「失败 · 重试」，不拿假数据冒充。换来源只换 MonthSource。
 */
import { useCallback, useEffect, useState } from "react";
import type { TMonthDraft, TMonthPageResponse, TMonthTask } from "@warmap/contracts";

/** 这个月的一件 Task；settlement 不为 null 的已经了结（完成、到此为止、已延续）。 */
export type MonthTask = TMonthTask;
export type MonthDraft = TMonthDraft;
export type MonthPageData = TMonthPageResponse;

export type MonthSource = {
  load: (period: string) => Promise<MonthPageData>;
};

/** 「2026-11」的下一个月「2026-12」。 */
export function nextPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** 假数据：接口上之前，开发和测试里用（也是给 B2 的样例）。 */
export function monthFixture(period: string): MonthPageData {
  const next = nextPeriod(period);
  return {
    period,
    tasks: [
      { taskId: "fixture-home", missionId: "fixture-m1", missionTitle: "首页与派活", missionOutcome: "首页和派活每天有人用", name: "新首页改版",
        criteria: [{ text: "首页只放等你", met: true }, { text: "派活一步到位", met: true }, { text: "手机上能用", met: false }], dueDate: `${period}-18`,
        disposition: "current", deferredTo: null, version: 2, running: 1, blocked: 0, done: false, settlement: null, continuedFrom: null },
      { taskId: "fixture-meeting", missionId: "fixture-m1", missionTitle: "首页与派活", missionOutcome: "首页和派活每天有人用", name: "会后写回本体",
        criteria: [{ text: "会后自动写回", met: true }], dueDate: `${period}-30`, disposition: "current", deferredTo: null, version: 3, running: 0, blocked: 0, done: true,
        settlement: { kind: "completed", at: `${period}-20T08:00:00.000Z`, by: null, note: null, to: null }, continuedFrom: null },
      { taskId: "fixture-review", missionId: "fixture-m2", missionTitle: "复盘与拆解", missionOutcome: null, name: "月度复盘入口",
        criteria: [{ text: "复盘进新首页", met: false }, { text: "逐条对验收", met: false }], dueDate: `${period}-30`, disposition: "deferred", deferredTo: next,
        version: null, running: 0, blocked: 1, done: false,
        settlement: { kind: "continued", at: `${period}-28T08:00:00.000Z`, by: null, note: null, to: { taskId: "fixture-review-next", name: "复盘入口收尾", missionId: "fixture-m3", period: next } },
        continuedFrom: null },
    ],
    draft: {
      period: next,
      missions: [{
        id: "fixture-mission", title: "首页与派活",
        tasks: [
          { id: "fixture-draft-1", name: "新首页收尾", continuesFrom: { taskId: "fixture-home", name: "新首页改版", period, summary: "交付第 2 版" } },
          { id: "fixture-draft-2", name: "CEO 的新首页", continuesFrom: null },
        ],
      }],
    },
  };
}

class Missing extends Error {}

/** 先问 B2 的接口；404（还没有）时开发、测试里退回假数据，生产里报错。 */
export function httpMonthSource(request: typeof fetch = (...args) => fetch(...args), fallback = process.env.NODE_ENV !== "production"): MonthSource {
  const call = async (path: string, init?: RequestInit) => {
    const response = await request(path, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...init?.headers } });
    if (response.status === 404) throw new Missing();
    if (!response.ok) throw new Error(`没读到（${response.status}）`);
    return response;
  };
  return {
    load: async (period) => {
      try { return await (await call(`/api/me/months/${encodeURIComponent(period)}`)).json() as MonthPageData; }
      catch (error) {
        if (!(error instanceof Missing) || !fallback) throw error instanceof Missing ? new Error("月份接口还没有") : error;
        return monthFixture(period);
      }
    },
  };
}

export const monthSource: MonthSource = httpMonthSource();

/** 月份页用的：data（null 是还在读）、failed（没读到的原因）、retry。 */
export function useMonthPage(period: string, source: MonthSource = monthSource) {
  const [data, setData] = useState<MonthPageData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(null);
    void source.load(period).then(setData).catch((error: unknown) => setFailed(error instanceof Error ? error.message : ""));
  }, [period, source]);
  useEffect(load, [load]);
  return { data, failed, retry: load };
}

