"use client";

/**
 * 月份页的数据（设计 10.4、10.5、12.4）：接口由 B2 做（跨月延续），还没有。这里先定形状，页面只认这个形状：
 * - GET  /api/me/months/:period → MonthPageData：这个月的每件 Task 和天枢备好的状态（约定几条达到、交付第几版、还在跑的、受阻的、本人确认完成没有、复盘时怎么定的），
 *   以及下个月 Co-Agent 的草稿（Mission 和 Task，延续来的带「接着哪件」和那件现在的状态）。
 * - PUT  /api/me/months/:period/tasks/:taskId/decision，体 MonthAnswer → 204：复盘时这件怎么办（继续做 / 改一改再做 / 到此为止，可以补一句话）。
 *   答案就是交给 Co-Agent 的「负责人 agent 参考信息」（怎么交在等溪南，10.8）。
 * 接口还没有（404）时：开发和测试里用假数据（monthFixture），生产里写「失败 · 重试」，不拿假数据冒充。换来源只换 MonthSource。
 */
import { useCallback, useEffect, useState } from "react";

export type MonthChoice = "continue" | "revise" | "stop";
/** 复盘时这件怎么办：选了哪个（只补一句话时为 null）和补的那句话。 */
export type MonthAnswer = { choice: MonthChoice | null; note: string | null };

export type MonthTask = {
  taskId: string;
  missionTitle: string;
  name: string;
  /** 约定达到了几条（有证据）/ 共几条；没有约定为 null。 */
  agreement: { met: number; total: number } | null;
  /** 交付到第几版；没交过为 null。 */
  version: number | null;
  /** 还在跑的子会话。 */
  running: number;
  /** 受阻的子会话（卡在哪）。 */
  blocked: number;
  /** 本人确认完成了（最近一次交付，之后没返工）：不问怎么办。 */
  done: boolean;
  /** 复盘时已经定了的；还没定为 null。 */
  answer: MonthAnswer | null;
};

export type MonthDraftTask = {
  id: string;
  name: string;
  /** 延续来的：接着上个月的哪件，那件现在的状态（一行，同上半部分的小字）。新起的为 null。 */
  continuesFrom: { taskId: string; name: string; period: string; summary: string } | null;
};
export type MonthDraft = { period: string; missions: { id: string; title: string; tasks: MonthDraftTask[] }[] };

export type MonthPageData = {
  /** 这一页是哪个月（YYYY-MM）。 */
  period: string;
  tasks: MonthTask[];
  /** 下个月 Co-Agent 的草稿；还没到为 null。 */
  draft: MonthDraft | null;
};

export type MonthSource = {
  load: (period: string) => Promise<MonthPageData>;
  decide: (period: string, taskId: string, answer: MonthAnswer) => Promise<void>;
};

export const CHOICE_LABEL: Record<MonthChoice, string> = { continue: "继续做", revise: "改一改再做", stop: "到此为止" };

/** 「2026-11」的下一个月「2026-12」。 */
export function nextPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** Task 那一行的小字：「约定 2/3 · 交付第 2 版 · 进行中 1」，是 0 的、没有的不写；受阻的写在最后。 */
export function monthSummary(task: Pick<MonthTask, "agreement" | "version" | "running" | "blocked">): string {
  return [
    task.agreement ? `约定 ${task.agreement.met}/${task.agreement.total}` : null,
    task.version ? `交付第 ${task.version} 版` : "未交付",
    task.running ? `进行中 ${task.running}` : null,
    task.blocked ? `受阻 ${task.blocked}` : null,
  ].filter(Boolean).join(" · ");
}

/** 答了什么（收起那一行的答案）：选了的那个，补了话的接在后面。 */
export function answerText(answer: MonthAnswer): string {
  return [answer.choice ? CHOICE_LABEL[answer.choice] : null, answer.note].filter(Boolean).join("：");
}

/** 假数据：接口上之前，开发和测试里用（也是给 B2 的样例）。 */
export function monthFixture(period: string): MonthPageData {
  const next = nextPeriod(period);
  return {
    period,
    tasks: [
      { taskId: "fixture-home", missionTitle: "首页与派活", name: "新首页改版", agreement: { met: 2, total: 3 }, version: 2, running: 1, blocked: 0, done: false, answer: null },
      { taskId: "fixture-meeting", missionTitle: "首页与派活", name: "会后写回本体", agreement: { met: 3, total: 3 }, version: 3, running: 0, blocked: 0, done: true, answer: null },
      { taskId: "fixture-review", missionTitle: "复盘与拆解", name: "月度复盘入口", agreement: { met: 0, total: 2 }, version: null, running: 0, blocked: 1, done: false, answer: null },
    ],
    draft: {
      period: next,
      missions: [{
        id: "fixture-mission", title: "首页与派活",
        tasks: [
          { id: "fixture-draft-1", name: "新首页收尾", continuesFrom: { taskId: "fixture-home", name: "新首页改版", period, summary: "约定 2/3 · 交付第 2 版" } },
          { id: "fixture-draft-2", name: "CEO 的新首页", continuesFrom: null },
        ],
      }],
    },
  };
}

class Missing extends Error {}

/** 先问 B2 的接口；404（还没有）时开发、测试里退回假数据，生产里报错。 */
export function httpMonthSource(request: typeof fetch = (...args) => fetch(...args), fallback = process.env.NODE_ENV !== "production"): MonthSource {
  const answers = new Map<string, MonthAnswer>();
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
        const data = monthFixture(period);
        return { ...data, tasks: data.tasks.map((task) => ({ ...task, answer: answers.get(`${period}:${task.taskId}`) ?? null })) };
      }
    },
    decide: async (period, taskId, answer) => {
      try { await call(`/api/me/months/${encodeURIComponent(period)}/tasks/${encodeURIComponent(taskId)}/decision`, { method: "PUT", body: JSON.stringify(answer) }); }
      catch (error) {
        if (!(error instanceof Missing) || !fallback) throw error instanceof Missing ? new Error("月份接口还没有") : error;
        answers.set(`${period}:${taskId}`, answer);
      }
    },
  };
}

export const monthSource: MonthSource = httpMonthSource();

/** 月份页用的：data（null 是还在读）、failed（没读到的原因）、retry、decide（答一件，答完这一件收成一行）。 */
export function useMonthPage(period: string, source: MonthSource = monthSource) {
  const [data, setData] = useState<MonthPageData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => {
    setFailed(null);
    void source.load(period).then(setData).catch((error: unknown) => setFailed(error instanceof Error ? error.message : ""));
  }, [period, source]);
  useEffect(load, [load]);
  const decide = useCallback(async (taskId: string, answer: MonthAnswer) => {
    await source.decide(period, taskId, answer);
    setData((current) => current && { ...current, tasks: current.tasks.map((task) => (task.taskId === taskId ? { ...task, answer } : task)) });
  }, [period, source]);
  return { data, failed, retry: load, decide };
}

