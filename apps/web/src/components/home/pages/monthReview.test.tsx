import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MonthReviewView } from "./MonthReview";
import {
  countText, dispositionOptions, dispositionText, headText, httpReviewSource, isReviewPeriod, needsNote,
  type MonthReview, type ReviewActions, type ReviewCriterion, type ReviewTask,
} from "./useMonthReview";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = async () => undefined;
const actions: ReviewActions = { setDisposition: noop, rate: noop, addLink: noop, removeLink: noop, candidates: async () => [], confirm: noop };
const render = (review: MonthReview) => renderToStaticMarkup(<MonthReviewView review={review} actions={actions} />);

const ME = { personId: "p-me", name: "我" };
const XINAN = { personId: "p-xinan", name: "溪南" };
let linkSeq = 0;
const link = (title: string) => ({ id: `00000000-0000-4000-8000-${String(++linkSeq).padStart(12, "0")}`, title, url: `https://example.com/${linkSeq}`, source: "agent" as const });
const crit = (index: number, text: string, agentRating: ReviewCriterion["agentRating"], links: ReviewCriterion["links"] = []): ReviewCriterion =>
  ({ index, text, agentRating, agentBasis: agentRating ? "对这条的卡验收过了" : null, rating: null, ratedBy: null, note: null, links });
const task = (taskId: string, missionId: string, missionTitle: string, name: string, criteria: ReviewCriterion[], extra: Partial<ReviewTask> = {}): ReviewTask => ({
  taskId, name, missionId, missionTitle, responsible: ME, disposition: "current", deferredTo: null, dispositionBy: null, canChange: true, criteria, ...extra,
});
/** 服务端回的复盘页的样子（B 的 monthReview.ts）：两块是本人的 Mission，一块是别人 Mission 下本人的 Task；延期、取消各一件在最下面。 */
const sample = (): MonthReview => ({
  period: "2026-11", deadline: "2026-12-01T10:00:00.000Z", prefill: { status: "done", error: null }, toConfirm: 2, deferred: 1, cancelled: 1,
  missions: [
    { missionId: "m1", code: "M1", title: "首页与派活", owner: ME, verdict: "partial", met: 2, total: 4, deferred: 1, cancelled: 0, confirmedAt: null, confirmedBy: null, canConfirm: true, tasks: [
      task("t-home", "m1", "首页与派活", "新首页改版", [crit(1, "三栏不出横向滚动", "met", [link("PR #81")]), crit(2, "详情在右栏打开", "partial"), crit(3, "手持能派活", "unmet")]),
      task("t-push", "m1", "首页与派活", "飞书推送收敛", [crit(1, "只推要拍板的事", "met")]),
    ] },
    { missionId: "m2", code: "M2", title: "复盘与拆解", owner: ME, verdict: "not_achieved", met: 0, total: 1, deferred: 0, cancelled: 1, confirmedAt: null, confirmedBy: null, canConfirm: true, tasks: [
      task("t-review", "m2", "复盘与拆解", "复盘进新首页", [crit(1, "能定去向", "partial")]),
    ] },
    { missionId: "m3", code: "M3", title: "会后写回本体", owner: XINAN, verdict: "achieved", met: 1, total: 1, deferred: 0, cancelled: 0, confirmedAt: null, confirmedBy: null, canConfirm: false, tasks: [
      task("t-meeting", "m3", "会后写回本体", "会议链联调", [crit(1, "十分钟内写进本体", "met")]),
    ] },
  ],
  setAside: [
    task("t-local", "m1", "首页与派活", "本机程序发布", [], { disposition: "deferred", deferredTo: "2026-12" }),
    task("t-weekly", "m2", "复盘与拆解", "周复盘自动起草", [], { disposition: "cancelled" }),
  ],
});

describe("复盘第三版：几处规矩和字", () => {
  it("在不在复盘（同服务端）：月份过去了是；本月最后两天是；本月中间、以后的月份不是", () => {
    expect(isReviewPeriod("2026-10", "2026-11-01")).toBe(true);
    expect(isReviewPeriod("2026-11", "2026-11-11")).toBe(false);
    expect(isReviewPeriod("2026-11", "2026-11-29")).toBe(true);
    expect(isReviewPeriod("2026-11", "2026-11-30")).toBe(true);
    expect(isReviewPeriod("2026-12", "2026-11-30")).toBe(false);
    expect(isReviewPeriod("2027-02", "2027-02-27")).toBe(true);
  });
  it("备注必填同服务端：有预评、改得不一样才要写；预评还没出不强求", () => {
    expect(needsNote({ agentRating: "partial" }, "met")).toBe(true);
    expect(needsNote({ agentRating: "partial" }, "partial")).toBe(false);
    expect(needsNote({ agentRating: null }, "met")).toBe(false);
  });
  it("去向下拉：本期验收、下个月起三个月、已取消；跨年照样排", () => {
    expect(dispositionOptions("2026-11").map((option) => option.label)).toEqual(["本期验收", "延期到 12 月", "延期到 1 月", "延期到 2 月", "已取消"]);
    expect(dispositionOptions("2026-11")[1]!.body).toEqual({ disposition: "deferred", deferredTo: "2026-12" });
    expect(dispositionText({ disposition: "deferred", deferredTo: "2027-01" })).toBe("延期到 1 月");
  });
  it("页头小字和 Mission 那一行的数：是 0 的不写；预评在做时写「预评中」", () => {
    expect(headText(sample())).toBe("截止 12/1 18:00 · 待确认 2 · 延期 1 · 取消 1");
    expect(headText({ ...sample(), prefill: { status: "running", error: null } })).toContain("预评中");
    expect(countText({ met: 4, total: 5, deferred: 1, cancelled: 0 })).toBe("4/5 · 延期 1");
    expect(countText({ met: 0, total: 0, deferred: 0, cancelled: 2 })).toBe("取消 2");
  });
});

describe("复盘页的画法", () => {
  it("Mission 一块只放本期验收的；延期和取消在最下面一件一行，不评定", () => {
    const html = render(sample());
    const page = text(html);
    expect(page).toContain("首页与派活 部分达成 2/4 · 延期 1");
    expect(page).toContain("验收标准 评定 交付");
    expect(page).toMatch(/延期和取消 本机程序发布 首页与派活 延期到 12 月 .*周复盘自动起草 复盘与拆解 已取消/);
    expect(html.match(/data-testid="review-aside-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="review-criterion"/g)).toHaveLength(6);
  });
  it("别人的 Mission：没有确认按钮；自己是 Mission 负责人才有", () => {
    const html = render(sample());
    expect(html.match(/data-testid="review-confirm"/g)).toHaveLength(2);
    expect(text(html)).toContain("会后写回本体 达成 1/1");
  });
  it("改不了的只看：没有下拉、备注框、添加", () => {
    const review = sample();
    const locked: MonthReview = { ...review, missions: review.missions.map((mission) => ({ ...mission, tasks: mission.tasks.map((entry) => ({ ...entry, canChange: false })) })),
      setAside: review.setAside.map((entry) => ({ ...entry, canChange: false })) };
    const html = render(locked);
    for (const id of ["review-disposition", "review-note", "review-add-link", "review-rating"]) expect(html).not.toContain(id);
  });
  it("确认过的收成一行：Mission 名、总评、已确认那天", () => {
    const review = sample();
    const confirmed: MonthReview = { ...review, missions: review.missions.map((mission, index) => (index === 0 ? { ...mission, confirmedAt: "2026-11-29T02:00:00.000Z", confirmedBy: ME } : mission)) };
    const html = render(confirmed);
    expect(text(html)).toContain("首页与派活 部分达成 已确认 11/29");
    expect(html.match(/data-confirmed=""/g)).toHaveLength(1);
  });
  it("本人改了预评：评定下面淡色写预评是什么", () => {
    const review = sample();
    const first = review.missions[0]!.tasks[0]!;
    const changed: MonthReview = { ...review, missions: [{ ...review.missions[0]!, tasks: [{ ...first, criteria: [{ ...first.criteria[1]!, rating: "met", note: "已经在右栏打开" }] }] }], setAside: [] };
    expect(text(render(changed))).toMatch(/达到 预评 部分达到/);
  });
});

describe("接 B 的接口", () => {
  it("读回原样；404 当没有复盘；写操作换上服务端回的整份；出错带上服务端那句", async () => {
    const served = sample();
    const calls: string[] = [];
    const source = httpReviewSource(async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).includes("2026-09")) return new Response("{}", { status: 404 });
      if (String(input).endsWith("/criteria/2")) return new Response(JSON.stringify({ code: "NOTE_REQUIRED", message: "改了预评，要写一句实际完成得怎么样" }), { status: 400 });
      return new Response(JSON.stringify(served), { status: 200 });
    });
    expect(await source.load("2026-11")).toEqual(served);
    expect(await source.load("2026-09")).toBeNull();
    expect(await source.setDisposition("2026-11", "t1", { disposition: "cancelled" })).toEqual(served);
    await expect(source.rate("2026-11", "t1", 2, { rating: "met", note: null })).rejects.toThrow("改了预评，要写一句实际完成得怎么样");
    expect(calls).toEqual(["GET /api/me/months/2026-11/review", "GET /api/me/months/2026-09/review", "PUT /api/me/months/2026-11/review/tasks/t1/disposition", "PUT /api/me/months/2026-11/review/tasks/t1/criteria/2"]);
  });
  it("写的时候 404 照服务端那句报，不当没有复盘", async () => {
    const source = httpReviewSource(async () => new Response(JSON.stringify({ message: "这次复盘里没有这件 Task" }), { status: 404 }));
    await expect(source.setDisposition("2026-11", "x", { disposition: "current" })).rejects.toThrow("这次复盘里没有这件 Task");
  });
  it("没有体的写操作（确认、删交付）不带 JSON 头", async () => {
    const heads: (string | null)[] = [];
    const source = httpReviewSource(async (_input, init) => {
      heads.push(new Headers(init?.headers).get("content-type"));
      return new Response(JSON.stringify(sample()), { status: 200 });
    });
    await source.confirm("2026-11", "m1");
    await source.removeLink("2026-11", "l1");
    await source.setDisposition("2026-11", "t1", { disposition: "current" });
    expect(heads).toEqual([null, null, "application/json"]);
  });
});
