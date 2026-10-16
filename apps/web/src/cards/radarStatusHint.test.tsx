import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import { RadarCard, radarScanStatusLine, radarStatusLine } from "./RadarCard";
import type { RadarPayload } from "./payloads";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const css = readFileSync(new URL("../styles/radar-feed.module.css", import.meta.url), "utf8");

const payload = {
  timezone: "Asia/Shanghai",
  lookbackHours: 72,
  anchors: [{ id: "a1", title: "企业 Agent 监管", query: "海外监管", location: { type: "company" } }],
  scheduledCompanyDay: "2026-09-22",
  unreadCount: 1,
  lastScheduledAt: "2026-09-21T16:06:00+08:00",
  lastRun: { trigger: "manual", status: "completed", companyDay: "2026-09-22", warnings: [] },
  sources: { web: { configured: true, sourceCount: 1, message: "已配置" } },
};

const card = {
  schemaVersion: 1,
  id: "radar:1",
  version: 1,
  kind: "radar",
  objectRef: { type: "radar", id: "1", version: 1 },
  title: "雷达",
  payload,
  actions: [],
} as unknown as Card;

const signal = (id: string, title: string, state: Record<string, boolean>, publishedAt: string, impact: number) =>
  ({
    schemaVersion: 1,
    id: `signal:${id}`,
    version: 1,
    kind: "signal",
    objectRef: { type: "signal", id, version: 1 },
    title,
    badge: "CNBC",
    payload: {
      source: { type: "outlet", title, url: "https://example.com", publishedAt, excerpt: "" },
      assessment: { anchorId: "a1", location: { type: "company" }, summary: `${title}的摘要`, strategicImpact: "", evidenceQuote: "", unknowns: [], score: { relevance: 1, impact, urgency: 1 } },
      state: { read: false, saved: false, dismissed: false, ...state },
      collectedAt: publishedAt,
    },
    actions: [],
  }) as unknown as Card;

const render = (collection: Card[]) =>
  renderToStaticMarkup(
    <WorkspaceTestProvider>
      <RadarCard card={card} collection={collection} onCard={() => undefined} onNavigate={() => undefined} />
    </WorkspaceTestProvider>,
  );

/** clark 雷达展开页：页头、筛选 / 排序、可见的状态行、一竖列信号。 */
describe("雷达信号列表", () => {
  it("页头：外部信息 · 雷达 + 雷达信号，圆形关闭回到全局", () => {
    const html = render([]);
    expect(html).toContain("外部信息 · 雷达");
    expect(html).toContain(">雷达信号<");
    expect(html).toContain('aria-label="返回全局"');
    expect(html).toContain('data-context-mark="signal"');
  });

  it("工具条：全部 / 未读 / 收藏，按时间 / 按重要程度，监测范围与发现更多", () => {
    const html = render([]);
    for (const label of ["全部", "未读", "收藏", "按时间", "按重要程度", "监测范围", "发现更多"]) expect(html).toContain(label);
  });

  it("状态行常显（clark role=status），写明方式、结果、时间与未读数", () => {
    expect(radarStatusLine(payload as RadarPayload, false)).toBe("手动刷新已完成 · 9/21 16:06 · 1 条未读");
    // 手动刷新写这次运行的完成时间，而不是上次定时扫描的时间。
    const manual = { ...payload, lastRun: { ...payload.lastRun, completedAt: "2026-09-24T03:12:00.000Z" } };
    expect(radarStatusLine(manual as RadarPayload, false)).toBe("手动刷新已完成 · 9/24 11:12 · 1 条未读");
    expect(radarStatusLine(payload as RadarPayload, true)).toBe("正在扫描外部信息");
    expect(render([])).toContain("手动刷新已完成 · 9/21 16:06 · 1 条未读");
    expect(css).toContain(".feed .status{margin:15px 0 20px}");
  });

  it("演示模式仍能刷新和设置，并如实显示扫描失败，不宣称每日自动调度", () => {
    expect(render([])).toContain("查看监测范围");
    expect(render([])).toContain("发现更多");
    expect(radarStatusLine({ ...payload, lastRun: null } as unknown as RadarPayload, false, false)).toBe("尚未扫描 · 点击「发现更多」开始");
    expect(radarScanStatusLine({ trigger: "manual", status: "failed", companyDay: "2026-09-22", createdSignals: 0, warnings: ["提供方不可用"] })).toBe("扫描未完成 · 新增 0 条信号");
    expect(radarScanStatusLine({ trigger: "manual", status: "completed", companyDay: "2026-09-22", createdSignals: 2, warnings: [] })).toBe("刷新完成 · 新增 2 条信号");
  });

  it("信号卡：来源 · 日期、文章标题、摘要、锚点、重要度；已隐藏的不出现；默认按重要程度", () => {
    const html = render([
      signal("s1", "旧的一条", {}, "2026-09-20T02:00:00.000Z", 5),
      signal("s2", "新的一条", { read: true }, "2026-09-22T02:00:00.000Z", 1),
      signal("s3", "隐藏的一条", { dismissed: true }, "2026-09-23T02:00:00.000Z", 1),
    ]);
    expect(html).toContain("CNBC · 2026/9/22");
    expect(html).toContain("新的一条的摘要");
    expect(html).toContain("企业 Agent 监管");
    expect(html).toContain(">已读<");
    expect(html).toContain(">新信号<");
    expect(html).not.toContain("隐藏的一条");
    expect(html).toContain("企业 Agent 监管 · 重要度 6/10");
    // 默认按重要程度（impact + urgency）：旧但更重要的一条在前。
    expect(html.indexOf("旧的一条")).toBeLessThan(html.indexOf("新的一条"));
  });

  it("没有信号时的空态是大白话，不出现「本体」这类内部用语", () => {
    expect(render([])).toContain("暂无信号，点击「发现更多」开始扫描");
    expect(render([])).not.toContain("本体");
  });
});
