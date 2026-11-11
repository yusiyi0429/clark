"use client";

/**
 * 复盘页的数据（设计《复盘进新首页_设计第三版》，B 的契约 packages/contracts/src/monthReview.ts）：
 * - GET    /api/me/months/:period/review → 复盘页（Mission 一块、延期和取消放最下面）；这个月没有复盘时 404，月份页照旧。
 * - PUT    …/review/tasks/:taskId/disposition            去向（本期验收 / 延期到某月 / 已取消）
 * - PUT    …/review/tasks/:taskId/criteria/:index        一条的评定和备注（和预评不同时备注必填）
 * - POST   …/review/tasks/:taskId/criteria/:index/links  挂一个交付（粘贴的链接，或弹层里点的一样）
 * - DELETE …/review/links/:linkId                        删一个交付
 * - GET    …/review/tasks/:taskId/link-candidates        「+ 添加」弹层上半部分
 * - POST   …/review/missions/:missionId/confirm          确认（Mission 负责人）
 * 写操作都回整份复盘页，网页直接换上，总评、条数都由服务端算。
 * 接口还没有（404）时：开发和测试里本月和以前的月份用假数据（reviewFixture，网页自己按同样的规则算总评），以后的月份当没有复盘；生产里当没有复盘。
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
/** 选了这一档要不要写备注：和预评不同（预评还没出也算不同）。 */
export const needsNote = (criterion: Pick<ReviewCriterion, "agentRating">, rating: ReviewRating) => rating !== criterion.agentRating;

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
  /** null：这个月没有复盘。 */
  load: (period: string) => Promise<MonthReview | null>;
  setDisposition: (period: string, taskId: string, body: TPutReviewDispositionRequest) => Promise<MonthReview>;
  rate: (period: string, taskId: string, index: number, body: TPutReviewCriterionRequest) => Promise<MonthReview>;
  addLink: (period: string, taskId: string, index: number, body: TAddReviewLinkRequest) => Promise<MonthReview>;
  removeLink: (period: string, linkId: string) => Promise<MonthReview>;
  candidates: (period: string, taskId: string) => Promise<LinkCandidate[]>;
  confirm: (period: string, missionId: string) => Promise<MonthReview>;
};

class Missing extends Error {}
/** 接口回的错：带上服务端那句（400 备注必填、403 改不了这种），没有就写状态码。 */
async function failure(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { message?: string; error?: { message?: string } } | null;
  return new Error(body?.error?.message ?? body?.message ?? `没成（${response.status}）`);
}

/** 先问 B 的接口；404（还没有）时开发、测试里本月和以前的月份退回假数据，生产里当没有复盘。 */
export function httpReviewSource(request: typeof fetch = (...args) => fetch(...args), fallback = process.env.NODE_ENV !== "production", today = () => new Date()): ReviewSource {
  const fixtures = new Map<string, FixtureStore>();
  const local = (period: string) => fixtures.get(period) ?? (() => { const store = fixtureStore(period); fixtures.set(period, store); return store; })();
  const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(today()).slice(0, 7);
  const base = (period: string) => `/api/me/months/${encodeURIComponent(period)}`;
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    // 没有体的（确认、删交付）不带 content-type：Fastify 见到 JSON 头配空体直接回 400。
    const response = await request(path, { credentials: "same-origin", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
    if (response.status === 404) throw new Missing();
    if (!response.ok) throw await failure(response);
    return await response.json() as T;
  };
  /** 写操作：接口没有时改假数据。 */
  const write = async (period: string, path: string, init: RequestInit, onFixture: (store: FixtureStore) => void): Promise<MonthReview> => {
    try { return await call<MonthReview>(`${base(period)}/review${path}`, init); }
    catch (error) {
      if (!(error instanceof Missing) || !fallback || !fixtures.has(period)) throw error instanceof Missing ? new Error("复盘接口还没有") : error;
      const store = local(period);
      onFixture(store);
      return store.view();
    }
  };
  return {
    load: async (period) => {
      try { return await call<MonthReview>(`${base(period)}/review`); }
      catch (error) {
        if (!(error instanceof Missing)) throw error;
        return fallback && period <= thisMonth() ? local(period).view() : null;
      }
    },
    setDisposition: (period, taskId, body) => write(period, `/tasks/${encodeURIComponent(taskId)}/disposition`, { method: "PUT", body: JSON.stringify(body) }, (store) => store.setDisposition(taskId, body)),
    rate: (period, taskId, index, body) => write(period, `/tasks/${encodeURIComponent(taskId)}/criteria/${index}`, { method: "PUT", body: JSON.stringify(body) }, (store) => store.rate(taskId, index, body)),
    addLink: (period, taskId, index, body) => write(period, `/tasks/${encodeURIComponent(taskId)}/criteria/${index}/links`, { method: "POST", body: JSON.stringify(body) }, (store) => store.addLink(taskId, index, body)),
    removeLink: (period, linkId) => write(period, `/links/${encodeURIComponent(linkId)}`, { method: "DELETE" }, (store) => store.removeLink(linkId)),
    candidates: async (period, taskId) => {
      try { return (await call<{ candidates: LinkCandidate[] }>(`${base(period)}/review/tasks/${encodeURIComponent(taskId)}/link-candidates`)).candidates; }
      catch (error) {
        if (!(error instanceof Missing) || !fallback || !fixtures.has(period)) throw error instanceof Missing ? new Error("复盘接口还没有") : error;
        return FIXTURE_CANDIDATES;
      }
    },
    confirm: (period, missionId) => write(period, `/missions/${encodeURIComponent(missionId)}/confirm`, { method: "POST" }, (store) => store.confirm(missionId)),
  };
}

export const reviewSource: ReviewSource = httpReviewSource();

/**
 * 复盘页用的：review（undefined 还在读、null 这个月没有复盘）、failed（没读到的原因）、retry，和几样写操作（成功后换上整份复盘页；没成抛给调用的地方写「失败 · 重试」）。
 * 预评还没出完时隔 5 秒再读一次。
 */
export function useMonthReview(period: string, source: ReviewSource = reviewSource) {
  const [review, setReview] = useState<MonthReview | null | undefined>(undefined);
  const [failed, setFailed] = useState<string | null>(null);
  const alive = useRef(period);
  const load = useCallback(() => {
    alive.current = period;
    setFailed(null);
    void source.load(period).then((data) => { if (alive.current === period) setReview(data); })
      .catch((error: unknown) => { if (alive.current === period) setFailed(error instanceof Error ? error.message : ""); });
  }, [period, source]);
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

// ---------- 假数据（接口上之前，开发和测试里用；也是给 B 的样例）----------

const ME = { personId: "fixture-me", name: "我" };
const XINAN = { personId: "fixture-xinan", name: "溪南" };
const FIXTURE_CANDIDATES: LinkCandidate[] = [
  { kind: "deliverable", id: "00000000-0000-4000-8000-000000000101", title: "新首页上线说明 v2", url: "https://example.feishu.cn/docx/fixture-home-v2", at: "2026-11-27T08:00:00.000Z" },
  { kind: "output", id: "00000000-0000-4000-8000-000000000102", title: "右栏拖宽截图.png", url: "https://example.com/fixture/right-panel.png", at: "2026-11-26T08:00:00.000Z" },
];

type FixtureTask = ReviewTask & { allCriteria: ReviewCriterion[] };
type FixtureStore = {
  view: () => MonthReview;
  setDisposition: (taskId: string, body: TPutReviewDispositionRequest) => void;
  rate: (taskId: string, index: number, body: TPutReviewCriterionRequest) => void;
  addLink: (taskId: string, index: number, body: TAddReviewLinkRequest) => void;
  removeLink: (linkId: string) => void;
  confirm: (missionId: string) => void;
};

/** 总评：只算本期验收的各条，全部达到为达成，一条都没达到为未达成，其余部分达成；没有条目或有没评的为 null。 */
export function verdictOf(criteria: Pick<ReviewCriterion, "rating" | "agentRating">[]): { verdict: TMissionVerdict | null; met: number; total: number } {
  const ratings = criteria.map(effectiveRating);
  const met = ratings.filter((rating) => rating === "met").length;
  if (!ratings.length || ratings.some((rating) => rating === null)) return { verdict: null, met, total: ratings.length };
  return { verdict: met === ratings.length ? "achieved" : met === 0 ? "not_achieved" : "partial", met, total: ratings.length };
}

let linkSeq = 0;
const fixtureLink = (title: string, url: string, source: "agent" | "person" = "agent") => ({ id: `00000000-0000-4000-8000-${String(++linkSeq).padStart(12, "0")}`, title, url, source });
const crit = (index: number, text: string, agentRating: ReviewRating | null, agentBasis: string | null, links: ReviewCriterion["links"] = []): ReviewCriterion =>
  ({ index, text, agentRating, agentBasis, rating: null, ratedBy: null, note: null, links });

export function reviewFixture(period: string): MonthReview {
  return fixtureStore(period).view();
}

function fixtureStore(period: string): FixtureStore {
  const next = nextPeriod(period);
  const missions = [
    { missionId: "fixture-m1", code: "M1", title: "首页与派活", owner: ME },
    { missionId: "fixture-m2", code: "M2", title: "复盘与拆解", owner: ME },
    { missionId: "fixture-m3", code: "M3", title: "会后写回本体", owner: XINAN },
  ];
  const task = (taskId: string, missionId: string, name: string, criteria: ReviewCriterion[], extra: Partial<ReviewTask> = {}): FixtureTask => ({
    taskId, name, missionId, missionTitle: missions.find((mission) => mission.missionId === missionId)!.title, responsible: ME,
    disposition: "current", deferredTo: null, dispositionBy: null, canChange: true, criteria: [], allCriteria: criteria, ...extra,
  });
  const tasks: FixtureTask[] = [
    task("fixture-home", "fixture-m1", "新首页改版", [
      crit(1, "新首页三栏在 1280 宽下不出横向滚动", "met", "对这条的卡验收过了", [fixtureLink("PR #81", "https://github.com/TokenkingOS/Tianshu-MVP/pull/81")]),
      crit(2, "子会话详情在右栏打开，不盖住对话", "partial", "有对这条的卡，还没验收"),
      crit(3, "手持布局能完成派活全流程", "unmet", "没读到相关交付"),
    ]),
    task("fixture-push", "fixture-m1", "飞书推送收敛", [
      crit(1, "飞书只推要拍板的事", "met", "本人确认完成", [fixtureLink("飞书推送规则", "https://example.feishu.cn/docx/fixture-push")]),
    ]),
    task("fixture-local", "fixture-m1", "本机程序发布", [crit(1, "安装包能在新电脑上装好并配对", null, null)], { disposition: "deferred", deferredTo: next }),
    task("fixture-review", "fixture-m2", "复盘进新首页", [
      crit(1, "每件 Task 能定本期验收、延期或取消", "partial", "有对这条的卡，还没验收"),
      crit(2, "延期的进顺延清单", "unmet", "没读到相关交付"),
    ]),
    task("fixture-weekly", "fixture-m2", "周复盘自动起草", [crit(1, "每周五出草稿", null, null)], { disposition: "cancelled" }),
    task("fixture-meeting", "fixture-m3", "会议链联调", [
      crit(1, "会后十分钟内写进本体", "met", "对这条的卡验收过了", [fixtureLink("会议链联调记录", "https://example.feishu.cn/docx/fixture-meeting")]),
    ], { responsible: ME }),
  ];
  const confirmed = new Map<string, string>();
  const find = (taskId: string) => tasks.find((entry) => entry.taskId === taskId)!;
  const unconfirm = (missionId: string) => confirmed.delete(missionId);
  const view = (): MonthReview => {
    const shown = (entry: FixtureTask): ReviewTask => {
      const { allCriteria, ...rest } = entry;
      return { ...rest, criteria: entry.disposition === "current" ? allCriteria : [] };
    };
    const blocks: ReviewMission[] = missions.flatMap((mission) => {
      const mine = tasks.filter((entry) => entry.missionId === mission.missionId);
      const current = mine.filter((entry) => entry.disposition === "current");
      if (!current.length && !mine.length) return [];
      const { verdict, met, total } = verdictOf(current.flatMap((entry) => entry.allCriteria));
      const at = confirmed.get(mission.missionId) ?? null;
      return [{ ...mission, verdict, met, total, deferred: mine.filter((entry) => entry.disposition === "deferred").length, cancelled: mine.filter((entry) => entry.disposition === "cancelled").length,
        confirmedAt: at, confirmedBy: at ? mission.owner : null, canConfirm: mission.owner.personId === ME.personId, tasks: current.map(shown) }];
    });
    const setAside = tasks.filter((entry) => entry.disposition !== "current").map(shown);
    return {
      period, deadline: `${next}-01T10:00:00.000Z`, prefill: { status: "done", error: null },
      toConfirm: blocks.filter((mission) => mission.canConfirm && !mission.confirmedAt && mission.tasks.length).length,
      deferred: setAside.filter((entry) => entry.disposition === "deferred").length, cancelled: setAside.filter((entry) => entry.disposition === "cancelled").length,
      missions: blocks.filter((mission) => mission.tasks.length), setAside,
    };
  };
  return {
    view,
    setDisposition: (taskId, body) => {
      const entry = find(taskId);
      entry.disposition = body.disposition;
      entry.deferredTo = body.disposition === "deferred" ? body.deferredTo ?? next : null;
      entry.dispositionBy = ME;
      unconfirm(entry.missionId);
    },
    rate: (taskId, index, body) => {
      const entry = find(taskId);
      const criterion = entry.allCriteria.find((row) => row.index === index)!;
      if (needsNote(criterion, body.rating) && !body.note?.trim()) throw new Error("和预评不同时要写备注");
      criterion.rating = body.rating === criterion.agentRating ? null : body.rating;
      criterion.ratedBy = criterion.rating ? ME : null;
      criterion.note = body.note?.trim() || null;
      unconfirm(entry.missionId);
    },
    addLink: (taskId, index, body) => {
      const entry = find(taskId);
      const criterion = entry.allCriteria.find((row) => row.index === index)!;
      const picked = "candidate" in body ? FIXTURE_CANDIDATES.find((candidate) => candidate.id === body.candidate.id) : null;
      if ("url" in body && !/^https?:\/\//.test(body.url)) throw new Error("只收 http 或 https 的链接");
      criterion.links.push(picked ? fixtureLink(picked.title, picked.url, "person") : fixtureLink("url" in body ? body.title ?? body.url : "", "url" in body ? body.url : "", "person"));
      unconfirm(entry.missionId);
    },
    removeLink: (linkId) => {
      for (const entry of tasks) for (const criterion of entry.allCriteria) {
        if (criterion.links.some((link) => link.id === linkId)) { criterion.links = criterion.links.filter((link) => link.id !== linkId); unconfirm(entry.missionId); }
      }
    },
    confirm: (missionId) => { confirmed.set(missionId, new Date().toISOString()); },
  };
}
