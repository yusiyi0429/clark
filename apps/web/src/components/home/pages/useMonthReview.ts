"use client";

/**
 * 复盘页的数据（设计《复盘进新首页_设计第三版》，B 的契约 packages/contracts/src/monthReview.ts）：
 * - GET    /api/me/months/:period/review → 复盘页（Mission 一块、延期和取消放最下面）。只在复盘的月份读（isReviewPeriod），别的月份月份页照旧。
 * - PUT    …/review/tasks/:taskId/disposition            去向（本期验收 / 延期到某月 / 已取消）
 * - PUT    …/review/tasks/:taskId/criteria/:index        一条的评定和备注（有预评、改得和预评不同时备注必填，同服务端）
 * - POST   …/review/tasks/:taskId/criteria/:index/links  挂一个交付（粘贴的链接，或弹层里点的一样）
 * - DELETE …/review/links/:linkId                        删一个交付
 * - GET    …/review/tasks/:taskId/link-candidates        「+ 添加」弹层上半部分
 * - POST   …/review/missions/:missionId/confirm          确认（Mission 负责人）
 * 写操作都回整份复盘页，网页直接换上，总评、条数都由服务端算。
 * 接口没有（404）时当没有复盘，月份页照旧。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  TAddReviewLinkRequest, TMissionVerdict, TMonthReviewCriterion, TMonthReviewMission, TMonthReviewResponse, TMonthReviewTask,
  TPutReviewCriterionRequest, TPutReviewDispositionRequest, TReviewDisposition, TReviewLinkCandidate, TReviewRating,
} from "@warmap/contracts";
import { monthLabel } from "@/lib/home/derive";
import { nextPeriod } from "./useMonthPage";

export type MonthReview = TMonthReviewResponse;
export type ReviewMission = TMonthReviewMission;
export type ReviewTask = TMonthReviewTask;
export type ReviewCriterion = TMonthReviewCriterion;
export type ReviewRating = TReviewRating;
export type ReviewDisposition = TReviewDisposition;
export type LinkCandidate = TReviewLinkCandidate;

export const RATING_LABEL: Record<ReviewRating, string> = { met: "达到", partial: "部分达到", unmet: "未达到" };
export const RATINGS: ReviewRating[] = ["met", "partial", "unmet"];
export const VERDICT_LABEL: Record<TMissionVerdict, string> = { achieved: "达成", partial: "部分达成", not_achieved: "未达成" };
/** 延期能选的月份：下个月起三个月（默认下个月）。 */
export const DEFER_MONTHS = 3;

/** 一条现在算什么：本人改过的按本人，没改的按预评。 */
export const effectiveRating = (criterion: Pick<ReviewCriterion, "rating" | "agentRating">) => criterion.rating ?? criterion.agentRating;
/** 选了这一档要不要写备注：有预评、选得和预评不同（同服务端；预评还没出时不强求）。 */
export const needsNote = (criterion: Pick<ReviewCriterion, "agentRating">, rating: ReviewRating) => criterion.agentRating !== null && rating !== criterion.agentRating;

/** 去向那个下拉上写的字：「本期验收」「延期到 12 月」「已取消」。 */
export function dispositionText(task: Pick<ReviewTask, "disposition" | "deferredTo">): string {
  if (task.disposition === "deferred") return `延期到 ${task.deferredTo ? monthLabel(task.deferredTo) : "下个月"}`;
  return task.disposition === "cancelled" ? "已取消" : "本期验收";
}

/** 去向下拉的几项：本期验收、延期到下个月起的三个月、已取消。key 是「current」「deferred:2026-12」「cancelled」。 */
export function dispositionOptions(period: string): { key: string; label: string; body: TPutReviewDispositionRequest }[] {
  const months: string[] = [];
  for (let month = nextPeriod(period); months.length < DEFER_MONTHS; month = nextPeriod(month)) months.push(month);
  return [
    { key: "current", label: "本期验收", body: { disposition: "current" } },
    ...months.map((month) => ({ key: `deferred:${month}`, label: `延期到 ${monthLabel(month)}`, body: { disposition: "deferred" as const, deferredTo: month } })),
    { key: "cancelled", label: "已取消", body: { disposition: "cancelled" } },
  ];
}
export const dispositionKey = (task: Pick<ReviewTask, "disposition" | "deferredTo">) => (task.disposition === "deferred" ? `deferred:${task.deferredTo}` : task.disposition);

/** 截止时间「12/1 18:00」（公司时区）。 */
export function deadlineText(iso: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}
/** 确认的日子「11/29」。 */
export function dayText(iso: string): string {
  const parts = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).formatToParts(new Date(iso));
  return `${parts.find((part) => part.type === "month")?.value}/${parts.find((part) => part.type === "day")?.value}`;
}

/** 页头右边的淡色小字：「截止 12/1 18:00 · 待确认 1 · 延期 2」，预评没出完时加「预评中」，没评成时「预评失败」。是 0 的不写。 */
export function headText(review: MonthReview): string {
  return [
    `截止 ${deadlineText(review.deadline)}`,
    review.prefill.status === "pending" || review.prefill.status === "running" ? "预评中" : review.prefill.status === "failed" ? "预评失败" : null,
    review.toConfirm ? `待确认 ${review.toConfirm}` : null,
    review.deferred ? `延期 ${review.deferred}` : null,
    review.cancelled ? `取消 ${review.cancelled}` : null,
  ].filter(Boolean).join(" · ");
}

/** Mission 标题行右边的数：「4/5 · 延期 1」。 */
export function countText(mission: Pick<ReviewMission, "met" | "total" | "deferred" | "cancelled">): string {
  return [mission.total ? `${mission.met}/${mission.total}` : null, mission.deferred ? `延期 ${mission.deferred}` : null, mission.cancelled ? `取消 ${mission.cancelled}` : null]
    .filter(Boolean).join(" · ");
}

export type ReviewSource = {
  /** null：接口没有这个月（404）。 */
  load: (period: string) => Promise<MonthReview | null>;
  setDisposition: (period: string, taskId: string, body: TPutReviewDispositionRequest) => Promise<MonthReview>;
  rate: (period: string, taskId: string, index: number, body: TPutReviewCriterionRequest) => Promise<MonthReview>;
  addLink: (period: string, taskId: string, index: number, body: TAddReviewLinkRequest) => Promise<MonthReview>;
  removeLink: (period: string, linkId: string) => Promise<MonthReview>;
  candidates: (period: string, taskId: string) => Promise<LinkCandidate[]>;
  confirm: (period: string, missionId: string) => Promise<MonthReview>;
};

class Missing extends Error {}
/** 接口回的错：带上服务端那句（400 备注必填、403 改不了、409 还有没评的这种），没有就写状态码。 */
async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { message?: string } | null;
  return new Error(body?.message ?? `没成（${response.status}）`);
}

/** B 的接口（apps/api/src/routes/monthReview.ts）。读的时候 404 当没有复盘，写的时候照服务端那句报。 */
export function httpReviewSource(request: typeof fetch = (...args) => fetch(...args)): ReviewSource {
  const base = (period: string) => `/api/me/months/${encodeURIComponent(period)}/review`;
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    // 没有体的（确认、删交付）不带 content-type：Fastify 见到 JSON 头配空体直接回 400。
    const response = await request(path, { credentials: "same-origin", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    if (response.status === 404 && !init?.method) throw new Missing();
    if (!response.ok) throw await failure(response);
    return await response.json() as T;
  };
  const write = (period: string, path: string, method: string, body?: unknown) =>
    call<MonthReview>(`${base(period)}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    load: async (period) => {
      try { return await call<MonthReview>(base(period)); }
      catch (error) { if (error instanceof Missing) return null; throw error; }
    },
    setDisposition: (period, taskId, body) => write(period, `/tasks/${encodeURIComponent(taskId)}/disposition`, "PUT", body),
    rate: (period, taskId, index, body) => write(period, `/tasks/${encodeURIComponent(taskId)}/criteria/${index}`, "PUT", body),
    addLink: (period, taskId, index, body) => write(period, `/tasks/${encodeURIComponent(taskId)}/criteria/${index}/links`, "POST", body),
    removeLink: (period, linkId) => write(period, `/links/${encodeURIComponent(linkId)}`, "DELETE"),
    candidates: async (period, taskId) => (await call<{ candidates: LinkCandidate[] }>(`${base(period)}/tasks/${encodeURIComponent(taskId)}/link-candidates`)).candidates,
    confirm: (period, missionId) => write(period, `/missions/${encodeURIComponent(missionId)}/confirm`, "POST"),
  };
}

export const reviewSource: ReviewSource = httpReviewSource();

/** 公司时区的今天（YYYY-MM-DD）：服务端给的（计划里的 today）优先，没有用这台电脑的钟。 */
const companyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/**
 * 这个月是不是在复盘（同服务端 monthReview.ts 的 reviewable）：月份已经过去，或者是本月的最后两天（复盘窗口开了）。
 * 不在复盘的月份（本月中间、以后的月份）月份页照旧。
 */
export function isReviewPeriod(period: string, today: string): boolean {
  const month = today.slice(0, 7);
  if (period < month) return true;
  if (period > month) return false;
  const [year, monthNo, day] = today.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, monthNo, 0)).getUTCDate();
  return day >= lastDay - 1;
}

/**
 * 复盘页用的：review（undefined 还在读、null 不是复盘的月份）、failed（没读到的原因）、retry，和几样写操作（成功后换上整份复盘页；没成抛给调用的地方写「失败 · 重试」）。
 * today：服务端的今天（计划里的 today），没有用这台电脑的钟。预评还没出完时隔 5 秒再读一次。
 */
export function useMonthReview(period: string, today: string | null = null, source: ReviewSource = reviewSource) {
  const [review, setReview] = useState<MonthReview | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const alive = useRef(period);
  const open = isReviewPeriod(period, today ?? companyToday());
  const load = useCallback(() => {
    alive.current = period;
    setFailed(null);
    if (!open) { setReview(null); return; }
    void source.load(period).then((data) => { if (alive.current === period) setReview(data); })
      .catch((error: unknown) => { if (alive.current === period) setFailed(error instanceof Error ? error.message : ""); });
  }, [period, source, open]);
  useEffect(load, [load]);
  const pending = review?.prefill.status === "pending" || review?.prefill.status === "running";
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(load, 5000);
    return () => window.clearTimeout(timer);
  }, [pending, review, load]);
  const apply = useCallback(async (run: Promise<MonthReview>) => { const next = await run; if (alive.current === period) setReview(next); }, [period]);
  const actions = {
    setDisposition: (taskId: string, body: TPutReviewDispositionRequest) => apply(source.setDisposition(period, taskId, body)),
    rate: (taskId: string, index: number, body: TPutReviewCriterionRequest) => apply(source.rate(period, taskId, index, body)),
    addLink: (taskId: string, index: number, body: TAddReviewLinkRequest) => apply(source.addLink(period, taskId, index, body)),
    removeLink: (linkId: string) => apply(source.removeLink(period, linkId)),
    candidates: (taskId: string) => source.candidates(period, taskId),
    confirm: (missionId: string) => apply(source.confirm(period, missionId)),
  };
  return { review, failed, retry: load, actions };
}
export type ReviewActions = ReturnType<typeof useMonthReview>["actions"];
