import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthReviewView } from "./MonthReview";
import {
  countText, dispositionOptions, dispositionText, headText, httpReviewSource, reviewFixture, verdictOf,
  type MonthReview, type ReviewActions,
} from "./useMonthReview";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = async () => undefined;
const actions: ReviewActions = { setDisposition: noop, rate: noop, addLink: noop, removeLink: noop, candidates: async () => [], confirm: noop };
const render = (review: MonthReview) => renderToStaticMarkup(<MonthReviewView review={review} actions={actions} />);
const missing = async () => new Response("{}", { status: 404 });
const NOV = () => new Date("2026-11-28T04:00:00.000Z");

describe("复盘第三版：总评和几处字", () => {
  it("总评只按评定算：全部达到为达成，一条都没达到为未达成，其余部分达成；有没评的不出", () => {
    const row = (rating: "met" | "partial" | "unmet" | null, agentRating: "met" | "partial" | "unmet" | null = null) => ({ rating, agentRating });
    expect(verdictOf([row(null, "met"), row("met", "unmet")])).toEqual({ verdict: "achieved", met: 2, total: 2 });
    expect(verdictOf([row(null, "partial"), row(null, "unmet")])).toEqual({ verdict: "not_achieved", met: 0, total: 2 });
    expect(verdictOf([row(null, "met"), row(null, "unmet")]).verdict).toBe("partial");
    expect(verdictOf([row(null, "met"), row(null, null)]).verdict).toBeNull();
    expect(verdictOf([]).verdict).toBeNull();
  });
  it("去向下拉：本期验收、下个月起三个月、已取消；跨年照样排", () => {
    expect(dispositionOptions("2026-11").map((option) => option.label)).toEqual(["本期验收", "延期到 12 月", "延期到 1 月", "延期到 2 月", "已取消"]);
    expect(dispositionOptions("2026-11")[1]!.body).toEqual({ disposition: "deferred", deferredTo: "2026-12" });
    expect(dispositionText({ disposition: "deferred", deferredTo: "2027-01" })).toBe("延期到 1 月");
  });
  it("页头小字和 Mission 那一行的数：是 0 的不写", () => {
    const review = reviewFixture("2026-11");
    expect(headText(review)).toBe("截止 12/1 18:00 · 待确认 2 · 延期 1 · 取消 1");
    expect(countText({ met: 4, total: 5, deferred: 1, cancelled: 0 })).toBe("4/5 · 延期 1");
    expect(countText({ met: 0, total: 0, deferred: 0, cancelled: 2 })).toBe("取消 2");
  });
});

describe("复盘页的画法", () => {
  it("Mission 一块只放本期验收的；延期和取消在最下面一件一行，不评定", () => {
    const html = render(reviewFixture("2026-11"));
    const page = text(html);
    expect(page).toContain("首页与派活 部分达成 2/4 · 延期 1");
    expect(page).toContain("验收标准 评定 交付");
    expect(page).toMatch(/延期和取消 本机程序发布 首页与派活 延期到 12 月 .*周复盘自动起草 复盘与拆解 已取消/);
    expect(html.match(/data-testid="review-aside-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="review-criterion"/g)).toHaveLength(7);
  });
  it("别人的 Mission：没有确认按钮；自己是 Mission 负责人才有", () => {
    const html = render(reviewFixture("2026-11"));
    expect(html.match(/data-testid="review-confirm"/g)).toHaveLength(2);
    expect(text(html)).toContain("会后写回本体 达成 1/1");
  });
  it("改不了的只看：没有下拉、备注框、添加", () => {
    const review = reviewFixture("2026-11");
    const locked: MonthReview = { ...review, missions: review.missions.map((mission) => ({ ...mission, tasks: mission.tasks.map((task) => ({ ...task, canChange: false })) })),
      setAside: review.setAside.map((task) => ({ ...task, canChange: false })) };
    const html = render(locked);
    expect(html).not.toContain("review-disposition");
    expect(html).not.toContain("review-note");
    expect(html).not.toContain("review-add-link");
    expect(html).not.toContain("review-rating");
  });
  it("确认过的收成一行：Mission 名、总评、已确认那天", () => {
    const review = reviewFixture("2026-11");
    const confirmed: MonthReview = { ...review, missions: review.missions.map((mission, index) => (index === 0 ? { ...mission, confirmedAt: "2026-11-29T02:00:00.000Z", confirmedBy: mission.owner } : mission)) };
    const html = render(confirmed);
    expect(text(html)).toContain("首页与派活 部分达成 已确认 11/29");
    expect(html.match(/data-confirmed=""/g)).toHaveLength(1);
  });
  it("本人改了预评：评定下面淡色写预评是什么", () => {
    const review = reviewFixture("2026-11");
    const first = review.missions[0]!.tasks[0]!;
    const changed: MonthReview = { ...review, missions: [{ ...review.missions[0]!, tasks: [{ ...first, criteria: [{ ...first.criteria[1]!, rating: "met", note: "已经在右栏打开" }] }] }], setAside: [] };
    expect(text(render(changed))).toMatch(/达到 预评 部分达到/);
  });
});

describe("复盘的数据来源", () => {
  it("接口 404：开发里本月和以前用假数据，以后的月份当没有复盘；生产里当没有复盘", async () => {
    const dev = httpReviewSource(missing, true, NOV);
    expect((await dev.load("2026-11"))?.missions.length).toBe(3);
    expect(await dev.load("2026-12")).toBeNull();
    expect(await httpReviewSource(missing, false, NOV).load("2026-11")).toBeNull();
  });
  it("接口在：读回原样，写操作换上服务端回的整份；出错带上服务端那句", async () => {
    const served = reviewFixture("2026-10");
    const calls: string[] = [];
    const source = httpReviewSource(async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).endsWith("/criteria/2")) return new Response(JSON.stringify({ error: { message: "和预评不同时要写备注" } }), { status: 400 });
      return new Response(JSON.stringify(served), { status: 200 });
    }, false, NOV);
    expect(await source.load("2026-10")).toEqual(served);
    expect(await source.setDisposition("2026-10", "t1", { disposition: "cancelled" })).toEqual(served);
    await expect(source.rate("2026-10", "t1", 2, { rating: "met", note: null })).rejects.toThrow("和预评不同时要写备注");
    expect(calls).toEqual(["GET /api/me/months/2026-10/review", "PUT /api/me/months/2026-10/review/tasks/t1/disposition", "PUT /api/me/months/2026-10/review/tasks/t1/criteria/2"]);
  });
  it("没有体的写操作（确认、删交付）不带 JSON 头", async () => {
    const heads: (string | null)[] = [];
    const source = httpReviewSource(async (_input, init) => {
      heads.push(new Headers(init?.headers).get("content-type"));
      return new Response(JSON.stringify(reviewFixture("2026-10")), { status: 200 });
    }, false, NOV);
    await source.confirm("2026-10", "m1");
    await source.removeLink("2026-10", "l1");
    await source.setDisposition("2026-10", "t1", { disposition: "current" });
    expect(heads).toEqual([null, null, "application/json"]);
  });
  it("假数据上走一遍：延期后挪到最下面、不计入总评；改评定不写备注不收；确认后再改就清掉确认", async () => {
    const source = httpReviewSource(missing, true, NOV);
    await source.load("2026-11");
    let review = await source.setDisposition("2026-11", "fixture-home", { disposition: "deferred" });
    expect(review.setAside.find((task) => task.taskId === "fixture-home")?.deferredTo).toBe("2026-12");
    expect(review.missions[0]!.tasks.map((task) => task.taskId)).toEqual(["fixture-push"]);
    expect(review.missions[0]!.verdict).toBe("achieved");
    await expect(source.rate("2026-11", "fixture-push", 1, { rating: "partial", note: null })).rejects.toThrow("备注");
    review = await source.confirm("2026-11", "fixture-m1");
    expect(review.missions[0]!.confirmedAt).not.toBeNull();
    review = await source.rate("2026-11", "fixture-push", 1, { rating: "partial", note: "推送开关还没上" });
    expect(review.missions[0]!.confirmedAt).toBeNull();
    expect(review.missions[0]!.tasks[0]!.criteria[0]).toMatchObject({ rating: "partial", note: "推送开关还没上" });
    review = await source.addLink("2026-11", "fixture-push", 1, { url: "https://github.com/x/y/pull/1" });
    expect(review.missions[0]!.tasks[0]!.criteria[0]!.links.map((link) => link.title)).toEqual(["飞书推送规则", "https://github.com/x/y/pull/1"]);
  });
});
