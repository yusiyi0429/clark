import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { RadarCard } from "./RadarCard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const css = readFileSync(new URL("../styles/radar-feed.module.css", import.meta.url), "utf8");

const card = {
  schemaVersion: 1,
  id: "radar:1",
  version: 1,
  kind: "radar",
  objectRef: { type: "radar", id: "1", version: 1 },
  title: "雷达",
  payload: {
    timezone: "Asia/Shanghai",
    lookbackHours: 72,
    anchors: [],
    scheduledCompanyDay: "2026-09-22",
    unreadCount: 1,
    lastScheduledAt: "2026-09-21T16:06:00+08:00",
    lastRun: { trigger: "manual", status: "completed", companyDay: "2026-09-22", warnings: [] },
    sources: { web: { configured: true, sourceCount: 1, message: "已配置" } },
  },
  actions: [],
} as unknown as Card;

const html = renderToStaticMarkup(
  <RadarCard card={card} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />,
);

/** 扫描状态不再常显成一行，改为工具栏右端 info 图标的 hover / focus 提示。 */
describe("Radar 扫描状态提示", () => {
  const status = "1 条未读 · 定时扫描 2026-09-22 · 最近一次手动补扫：completed · 上次启动 2026-09-21 16:06";

  it("状态文案只出现在 tooltip 里", () => {
    expect(html.split(status)).toHaveLength(2);
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('id="radar-scan-status"');
    expect(html).toContain('aria-label="扫描状态"');
    expect(html).toContain('aria-describedby="radar-scan-status"');
  });

  it("常显状态行与它的样式一起移除，气泡挂在工具栏右端", () => {
    expect(css).not.toContain(".status{");
    expect(css).toContain(".hintBubble{position:absolute;right:0;top:calc(100% + 8px);");
    expect(css).toContain(".hintTip:hover .hintBubble,.hintTip:focus-visible .hintBubble{opacity:1;visibility:visible}");
  });
});
