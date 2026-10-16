import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import {
  RADAR_DEFAULT_FILTERS,
  RADAR_DEFAULT_VIEW,
  RadarCard,
  radarDateWindow,
  radarFilterSummary,
  radarImportance,
  radarViewReducer,
  radarVisibleSignals,
  type RadarView,
} from "./RadarCard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const TODAY = "2026-10-09";

const radar = {
  schemaVersion: 1,
  id: "radar:default",
  version: 1,
  kind: "radar",
  objectRef: { type: "radar", id: "default", version: 1 },
  title: "雷达",
  payload: {
    timezone: "Asia/Shanghai",
    lookbackHours: 72,
    anchors: [{ id: "a1", title: "交付风险", query: "交付", location: { type: "company" } }],
    scheduledCompanyDay: null,
    unreadCount: 0,
    lastScheduledAt: null,
    lastRun: null,
    sources: { web: { configured: true, sourceCount: 1, message: "已配置" } },
  },
  actions: [],
} as unknown as Card;

type Score = { impact: number; urgency: number } | null;
const signal = (id: string, publishedAt: string, score: Score, state: { read?: boolean; saved?: boolean; dismissed?: boolean } = {}) =>
  ({
    schemaVersion: 1,
    id: `signal:${id}`,
    version: 1,
    kind: "signal",
    objectRef: { type: "signal", id, version: 1 },
    title: `标题${id}`,
    badge: "Web",
    payload: {
      source: { type: "web", title: `信号${id}`, url: "https://example.com", publishedAt, excerpt: "原文" },
      assessment: {
        anchorId: "a1",
        location: { type: "company" },
        summary: `摘要${id}`,
        strategicImpact: "",
        evidenceQuote: "",
        unknowns: [],
        score: score ? { relevance: 3, ...score } : null,
        scoreStatus: score ? "assessed" : "unassessed",
      },
      state: { read: false, saved: false, dismissed: false, ...state },
      collectedAt: "2026-10-09T06:00:00.000Z",
    },
    actions: [],
  }) as unknown as Card;

// 发布时间都写成 UTC；公司时区（Asia/Shanghai）比 UTC 快 8 小时。
const signals = [
  signal("A", "2026-10-08T02:00:00.000Z", { impact: 5, urgency: 4 }, { saved: true }), // 9 · 10/8 · 未读 · 收藏
  signal("B", "2026-10-09T02:00:00.000Z", { impact: 2, urgency: 1 }, { saved: true }), // 3 · 10/9 · 未读 · 收藏
  signal("C", "2026-09-01T02:00:00.000Z", { impact: 5, urgency: 5 }, { saved: true }), // 10 · 很早 · 未读 · 收藏
  signal("D", "2026-10-07T02:00:00.000Z", { impact: 4, urgency: 4 }, { read: true, saved: true }), // 8 · 已读
  signal("E", "2026-10-08T03:00:00.000Z", { impact: 5, urgency: 3 }), // 8 · 未收藏
  signal("U", "2026-10-09T03:00:00.000Z", null, { saved: true }), // 未评估 · 最新 · 未读 · 收藏
  signal("Z", "2026-10-06T02:00:00.000Z", { impact: 0, urgency: 0 }), // 真实评估为 0 分
  signal("X", "2026-10-09T04:00:00.000Z", { impact: 5, urgency: 5 }, { dismissed: true }), // 已隐藏
];

const ids = (view: RadarView, rows = signals) => radarVisibleSignals(rows, view, TODAY).map((row) => row.card.objectRef.id);
const view = (filters: Partial<RadarView["filters"]>, sort: RadarView["sort"] = "importance"): RadarView => ({
  sort,
  filters: { ...RADAR_DEFAULT_FILTERS, ...filters },
});
const render = (collection: Card[], initialView?: RadarView) =>
  renderToStaticMarkup(
    <WorkspaceTestProvider>
      <RadarCard card={radar} collection={collection} onCard={() => undefined} onNavigate={() => undefined} initialView={initialView} />
    </WorkspaceTestProvider>,
  );
const order = (html: string, titles: string[]) => titles.map((title) => html.indexOf(`>${title}<`));

describe("雷达默认重要排序", () => {
  it("首次打开按原生 impact + urgency 从高到低，同分按发布时间新→旧，未评估排最后，隐藏的不出现", () => {
    expect(RADAR_DEFAULT_VIEW.sort).toBe("importance");
    expect(RADAR_DEFAULT_VIEW.filters).toEqual(RADAR_DEFAULT_FILTERS);
    expect(ids(RADAR_DEFAULT_VIEW)).toEqual(["C", "A", "E", "D", "B", "Z", "U"]);

    const html = render(signals);
    const positions = order(html, ["信号C", "信号A", "信号E", "信号D", "信号B", "信号Z", "信号U"]);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((l, r) => l - r)).toEqual(positions);
    expect(html).not.toContain("信号X");
  });

  it("同分同时间按 id 稳定排序，与输入顺序无关", () => {
    const twins = [signal("t2", "2026-10-08T02:00:00.000Z", { impact: 3, urgency: 3 }), signal("t1", "2026-10-08T02:00:00.000Z", { impact: 3, urgency: 3 })];
    expect(ids(RADAR_DEFAULT_VIEW, twins)).toEqual(["t1", "t2"]);
    expect(ids(RADAR_DEFAULT_VIEW, [...twins].reverse())).toEqual(["t1", "t2"]);
  });

  it("工具条：阅读状态、收藏、发布日期、排序各自独立，默认选中按重要程度", () => {
    const html = render(signals);
    for (const label of ["全部", "未读", "已读", "收藏", "近 7 天", "按重要程度", "按时间"]) expect(html).toContain(label);
    for (const label of ["全部日期", "近 30 天", "自定义"]) expect(html).not.toContain(label);
    expect(html).toContain('aria-checked="true" data-selected="true">按重要程度<');
    expect(html).toContain('aria-checked="true" data-selected="true">全部<');
    expect(html).toMatch(/aria-label="只看近 7 天" aria-pressed="false"/);
    expect(html).toMatch(/aria-label="只看收藏" aria-pressed="false"/);
    expect(html).not.toContain("清空筛选");
  });
});

describe("收藏 + 未读 + 日期组合取交集", () => {
  it("收藏 ∩ 未读 ∩ 近 7 天（公司时区今天起往前 7 天）", () => {
    expect(radarDateWindow(view({ date: "7d" }).filters, TODAY)).toEqual({ from: "2026-10-03" });
    expect(ids(view({ read: "unread", savedOnly: true, date: "7d" }))).toEqual(["A", "B", "U"]);
    // 每个条件单独生效：只要已读、只要收藏。
    expect(ids(view({ read: "read" }))).toEqual(["D"]);
    expect(ids(view({ savedOnly: true }))).toEqual(["C", "A", "D", "B", "U"]);
  });

  it("自定义日期区间按 Asia/Shanghai 的发布日判断，起止颠倒自动对调", () => {
    const edge = [
      signal("late", "2026-10-07T16:30:00.000Z", { impact: 1, urgency: 1 }), // 上海 10/8 00:30
      signal("next", "2026-10-08T16:30:00.000Z", { impact: 1, urgency: 1 }), // 上海 10/9 00:30
    ];
    expect(ids(view({ date: "custom", from: "2026-10-08", to: "2026-10-08" }), edge)).toEqual(["late"]);
    expect(ids(view({ date: "custom", from: "2026-10-08", to: "2026-10-08" }))).toEqual(["A", "E"]);
    expect(ids(view({ date: "custom", from: "2026-10-09", to: "2026-10-08" }))).toEqual(["A", "E", "B", "U"]);
    expect(ids(view({ date: "custom", from: "2026-10-09", to: "" }))).toEqual(["B", "U"]);
    // 自定义但未填日期：不限制。
    expect(ids(view({ date: "custom" }))).toEqual(ids(RADAR_DEFAULT_VIEW));
    expect(radarFilterSummary(view({ date: "custom", from: "2026-10-09" }).filters)).toBe("发布于 2026-10-09 及以后");
    expect(radarFilterSummary(view({ date: "custom", to: "2026-10-08" }).filters)).toBe("发布于 2026-10-08 及以前");
    expect(radarFilterSummary(view({ read: "unread", savedOnly: true, date: "7d" }).filters)).toBe("未读 · 已收藏 · 发布于近 7 天");
  });

  // 日期区间仍是筛选模型的一部分（自定义区间不再在工具条上露出），交集规则照旧。
  it("页面只显示交集，并给出数量与清空筛选入口", () => {
    const html = render(signals, view({ read: "unread", savedOnly: true, date: "custom", from: "2026-10-03", to: "2026-10-09" }));
    expect(html).toContain(">信号A<");
    expect(html).toContain(">信号B<");
    expect(html).toContain(">信号U<");
    for (const hidden of ["信号C", "信号D", "信号E", "信号Z"]) expect(html).not.toContain(`>${hidden}<`);
    expect(html).toContain('aria-checked="true" data-selected="true">未读<');
    expect(html).toMatch(/aria-label="只看收藏" aria-pressed="true"/);
    expect(html).toContain("显示 3 / 7 条");
    expect(html).toContain("清空筛选");
  });
});

describe("切换排序不改变筛选，清空筛选恢复全部", () => {
  it("换成按时间：筛选条件与结果集合不变，只有顺序变化", () => {
    const filtered = radarViewReducer(RADAR_DEFAULT_VIEW, { type: "filter", patch: { read: "unread", savedOnly: true, date: "7d" } });
    const byTime = radarViewReducer(filtered, { type: "sort", sort: "time" });
    expect(byTime.filters).toEqual(filtered.filters);
    expect(ids(byTime)).toEqual(["U", "B", "A"]);
    expect([...ids(byTime)].sort()).toEqual([...ids(filtered)].sort());
    const back = radarViewReducer(byTime, { type: "sort", sort: "importance" });
    expect(back.filters).toEqual(filtered.filters);
    expect(ids(back)).toEqual(["A", "B", "U"]);
  });

  it("清空筛选恢复全部未隐藏信号，保留当前排序", () => {
    const narrowed = radarViewReducer(view({ read: "read", savedOnly: true, date: "30d" }, "time"), { type: "filter", patch: { date: "custom", from: "2026-10-01" } });
    const cleared = radarViewReducer(narrowed, { type: "clear" });
    expect(cleared).toEqual({ sort: "time", filters: RADAR_DEFAULT_FILTERS });
    expect(ids(cleared)).toHaveLength(7);
    expect(render(signals, cleared)).not.toContain("清空筛选");
  });

  it("筛选排除了全部信号时，空态说明是筛选造成的并提供清空筛选；真的没有信号时仍是原空态", () => {
    const none = view({ read: "read", savedOnly: true, date: "custom", from: "2026-10-09", to: "2026-10-09" });
    expect(radarFilterSummary(none.filters)).toBe("已读 · 已收藏 · 发布于 2026-10-09 至 2026-10-09");
    const html = render(signals, none);
    expect(html).toContain("当前筛选条件排除了全部信号");
    expect(html).toContain("7 条信号都不满足「已读 · 已收藏 · 发布于 2026-10-09 至 2026-10-09」。清空筛选即可恢复全部信号。");
    expect(html).not.toContain("还没有信号");

    const empty = render([], none);
    expect(empty).toContain("暂无信号，点击「发现更多」开始扫描");
    expect(empty).not.toContain("当前筛选条件排除了全部信号");
  });
});

describe("未评估信号", () => {
  it("显示为重要度未评估而不是 0 分；真实 0 分照常显示", () => {
    const unassessed = signals.find((card) => card.objectRef.id === "U")!;
    const zero = signals.find((card) => card.objectRef.id === "Z")!;
    expect(radarImportance(unassessed.payload as never)).toBeNull();
    expect(radarImportance(zero.payload as never)).toBe(0);
    const html = render(signals);
    expect(html).toContain("交付风险 · 重要度未评估");
    expect(html).toContain("交付风险 · 重要度 0/10");
    expect(html).not.toContain("重要度 null");
  });

  it("按重要程度排在全部已评估信号（含 0 分）之后；按时间则按发布时间正常排列", () => {
    expect(ids(RADAR_DEFAULT_VIEW).at(-1)).toBe("U");
    expect(ids(view({}, "time"))[0]).toBe("U");
    // 多条未评估之间按发布时间新→旧。
    const pair = [signal("u1", "2026-10-01T02:00:00.000Z", null), signal("u2", "2026-10-02T02:00:00.000Z", null), signal("s", "2026-09-01T02:00:00.000Z", { impact: 0, urgency: 1 })];
    expect(ids(RADAR_DEFAULT_VIEW, pair)).toEqual(["s", "u2", "u1"]);
  });
});
