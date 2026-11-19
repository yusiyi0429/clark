"use client";

/**
 * 月份页的数据（设计 10.4、10.5、12.4），形状照 B2 的契约（packages/contracts/src/taskContinuity.ts）：
 * - GET  /api/me/months/:period → MonthPageData：这个月本人的每件 Task 和天枢备好的状态（Mission 的成果、完成标准原文和哪几条达到、验收时间点、去向、
 *   交付第几版、还在跑的、受阻的、本人确认完成没有、了结了没有（完成 / 到此为止 / 已延续，延续去了哪）、从哪件延续来的），以及下个月 Co-Agent 的草稿（暂为 null，等溪南）。
 *   第一版的复盘答案（PUT …/tasks/:taskId/decision）删了：去向和评定都在复盘页（useMonthReview）。
 * - PUT  /api/me/tasks/:taskId/due-date → 就地改验收时间点（按 Task 存，不要求挂项目）；null 退回记下的原验收时间点。
 * - PUT  /api/me/months/:period/review/tasks/:taskId/disposition → 定去向（和复盘页同一个接口，月中也能定）。
 * - PUT  /api/me/tasks/:taskId/goal → 就地改名字和完成标准（天枢里先生效、标未进本体；和本体一样就撤掉，「恢复」把原文存回去）。
 * - POST /api/me/months/:period/tasks → 「+ 添一件」，在本人这个月的 Mission 下新建一件天枢里的 Task（不写本体）。
 * 写完重读这一页；没成抛给调用的地方写「失败 · 重试」。
 * 接口还没有（404）时：开发和测试里用假数据（monthFixture），生产里写「失败 · 重试」，不拿假数据冒充。换来源只换 MonthSource。
 */
import { useCallback, useEffect, useState } from "react";
import type { TMonthDraft, TMonthPageResponse, TMonthTask, TPutReviewDispositionRequest, TPutTaskGoalRequest } from "@warmap/contracts";

/** 这个月的一件 Task；settlement 不为 null 的已经了结（完成、到此为止、已延续）。 */
export type MonthTask = TMonthTask;
export type MonthDraft = TMonthDraft;
export type MonthPageData = TMonthPageResponse;

export type MonthSource = {
  load: (period: string) => Promise<MonthPageData>;
  setDueDate: (taskId: string, dueDate: string | null) => Promise<void>;
  setDisposition: (period: string, taskId: string, body: TPutReviewDispositionRequest) => Promise<void>;
  setGoal: (taskId: string, body: TPutTaskGoalRequest) => Promise<void>;
  addTask: (period: string, missionId: string, name: string) => Promise<void>;
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
        criteria: [{ text: "首页只放等你", met: true, changed: false, original: null }, { text: "派活一步到位", met: true, changed: false, original: null },
          { text: "手机上能用", met: false, changed: true, original: "手机上不出错" }], edited: { name: null, criteria: ["首页只放等你", "派活一步到位", "手机上不出错"] }, added: false, dueDate: `${period}-18`, missionDueDate: `${period}-18`,
        disposition: "current", deferredTo: null, version: 2, running: 1, blocked: 0, done: false, settlement: null, continuedFrom: null },
      { taskId: "fixture-meeting", missionId: "fixture-m1", missionTitle: "首页与派活", missionOutcome: "首页和派活每天有人用", name: "会后写回本体",
        criteria: [{ text: "会后自动写回", met: true, changed: false, original: null }], edited: null, added: false, dueDate: `${period}-30`, missionDueDate: `${period}-30`, disposition: "current", deferredTo: null, version: 3, running: 0, blocked: 0, done: true,
        settlement: { kind: "completed", at: `${period}-20T08:00:00.000Z`, by: null, note: null, to: null }, continuedFrom: null },
      { taskId: "fixture-review", missionId: "fixture-m2", missionTitle: "复盘与拆解", missionOutcome: null, name: "月度复盘入口",
        criteria: [{ text: "复盘进新首页", met: false, changed: false, original: null }, { text: "逐条对验收", met: false, changed: false, original: null }], edited: null, added: false, dueDate: `${period}-30`, missionDueDate: `${period}-30`, disposition: "deferred", deferredTo: next,
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
  /** 写：带上服务端那句（400 日期不对、403 不是负责人这种），没有就写状态码。 */
  const write = async (path: string, body: unknown, method = "PUT") => {
    const response = await request(path, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json().catch(() => null) as { message?: string } | null)?.message ?? `没成（${response.status}）`);
  };
  return {
    load: async (period) => {
      try { return await (await call(`/api/me/months/${encodeURIComponent(period)}`)).json() as MonthPageData; }
      catch (error) {
        if (!(error instanceof Missing) || !fallback) throw error instanceof Missing ? new Error("月份接口还没有") : error;
        return monthFixture(period);
      }
    },
    setDueDate: (taskId, dueDate) => write(`/api/me/tasks/${encodeURIComponent(taskId)}/due-date`, { dueDate }),
    setDisposition: (period, taskId, body) => write(`/api/me/months/${encodeURIComponent(period)}/review/tasks/${encodeURIComponent(taskId)}/disposition`, body),
    setGoal: (taskId, body) => write(`/api/me/tasks/${encodeURIComponent(taskId)}/goal`, body),
    addTask: (period, missionId, name) => write(`/api/me/months/${encodeURIComponent(period)}/tasks`, { missionId, name }, "POST"),
  };
}

export const monthSource: MonthSource = httpMonthSource();

/** 月份页用的：data（null 是还在读）、failed（没读到的原因）、retry，和就地改的两样（写完重读；onChanged 给外壳刷新首页数据）。 */
export function useMonthPage(period: string, source: MonthSource = monthSource, onChanged?: () => void) {
  const [data, setData] = useState<MonthPageData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(null);
    void source.load(period).then(setData).catch((error: unknown) => setFailed(error instanceof Error ? error.message : ""));
  }, [period, source]);
  useEffect(load, [load]);
  const after = async (write: Promise<void>) => {
    await write;
    onChanged?.();
    setData(await source.load(period));
  };
  const actions: MonthActions = {
    setDueDate: (taskId, dueDate) => after(source.setDueDate(taskId, dueDate)),
    setDisposition: (taskId, body) => after(source.setDisposition(period, taskId, body)),
    setGoal: (taskId, body) => after(source.setGoal(taskId, body)),
    addTask: (missionId, name) => after(source.addTask(period, missionId, name)),
  };
  return { data, failed, retry: load, actions };
}
export type MonthActions = {
  setDueDate: (taskId: string, dueDate: string | null) => Promise<void>;
  setDisposition: (taskId: string, body: TPutReviewDispositionRequest) => Promise<void>;
  setGoal: (taskId: string, body: TPutTaskGoalRequest) => Promise<void>;
  addTask: (missionId: string, name: string) => Promise<void>;
};

