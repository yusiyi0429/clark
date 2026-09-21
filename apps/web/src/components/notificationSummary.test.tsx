import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { NotificationRail } from "./NotificationRail";

const css = readFileSync(new URL("../styles/notifications.module.css", import.meta.url), "utf8");

function card(kind: string, payload: unknown): Card {
  return {
    schemaVersion: 1,
    id: `${kind}:1`,
    version: 1,
    kind,
    objectRef: { type: kind, id: "1", version: 1 },
    title: kind === "issue" ? "TKOS 首期是否内建 Agent 安全控制？" : "月度计划 2026-09",
    payload,
    actions: [],
  } as unknown as Card;
}

const issue = card("issue", {
  origin: "radar",
  originRef: { strategicImpact: "该变化直接涉及企业 Agent 的授权与执行边界。" },
  status: "pending",
  location: { level: "company", relatedBattlefieldIds: [] },
  urgency: { level: "red", reason: "大客户交付窗口在九月关闭", decisionBy: "2026-09-01T00:00:00.000+08:00" },
  research: { status: "ready", doc: { summary: "预研结论：先内建最小安全控制，再扩 Skill 准入。" } },
  receipts: [],
  dismissedAt: null,
  dismissReason: null,
});

const monthly = card("monthly-plan", { period: "2026-09", companyOutcome: "把 Agent 安全基线纳入九月交付门。" });

/** W1：提请卡与月度卡的 body 默认收起，只在 hover / 键盘 focus 时卡内展开。 */
describe("通知卡 hover 摘要", () => {
  const html = renderToStaticMarkup(<NotificationRail cards={[issue, monthly]} onNavigate={() => undefined} />);

  it("提请卡把 ResearchDoc 摘要放进可展开区，默认态只显示标题与 reason/期限", () => {
    expect(html).toContain("预研结论：先内建最小安全控制，再扩 Skill 准入。");
    expect(html).toContain("大客户交付窗口在九月关闭");
    expect(html).toContain("TKOS 首期是否内建 Agent 安全控制？");
    expect(html.match(/role="tooltip"/g)).toHaveLength(2);
  });

  it("月度卡不再常显 companyOutcome，而是与提请卡同一可展开形态", () => {
    expect(html).toContain("把 Agent 安全基线纳入九月交付门。");
    expect(css).not.toContain(".headBody");
    expect(css).toContain(".cardSummary{display:block;max-height:0;overflow:hidden;opacity:0;");
    expect(css).toContain(".card:hover .cardSummary,.head:focus-visible .cardSummary{max-height:6.8em;opacity:1;margin-top:6px}");
  });

  // W5：左上角入口从登录态 Lock 换成配置入口。
  it("左上角入口是配置按钮，不再是锁图标", () => {
    expect(html).toContain('aria-label="配置"');
    expect(html).not.toContain('aria-label="已登录 CEO 会话"');
  });
});
