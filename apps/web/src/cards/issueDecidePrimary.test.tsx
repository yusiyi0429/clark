import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { IssueCard } from "./IssueCard";

// useCardAction 需要 Next 路由上下文；这里只渲染静态标记。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

/** 只覆盖决定表单的主行动标记：issue-workspace.module.css 依赖 data-primary 才会渲染 accent 主按钮。 */
const pendingIssue = {
  schemaVersion: 1,
  id: "issue:1",
  version: 1,
  kind: "issue",
  objectRef: { type: "issue", id: "1", version: 1 },
  title: "是否追加东南亚渠道预算 40%",
  payload: {
    origin: "radar",
    originRef: null,
    status: "pending",
    location: { level: "company", relatedBattlefieldIds: [] },
    urgency: { level: "red", decisionBy: null },
    research: { status: "ready", doc: { summary: "竞对在东南亚的履约时效已领先约 2 天。" } },
    receipts: [],
    dismissedAt: null,
    dismissReason: null,
  },
  actions: [{ actionType: "issue.decide" }],
} as unknown as Card;

describe("Issue 决定主行动", () => {
  it("把「直接决定」标记为 pen 主按钮，其余行动保持次要样式", () => {
    const html = renderToStaticMarkup(
      <IssueCard card={pendingIssue} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />,
    );
    expect(html).toMatch(/data-primary="true"[^>]*>直接决定/);
  });

  it("隐藏内部 kw 标识，并为 dismissed 状态显示终态元信息", () => {
    const dismissed = {
      ...pendingIssue,
      payload: {
        ...(pendingIssue.payload as object),
        status: "dismissed",
        location: { level: "company", relatedBattlefieldIds: ["kw:context", "growth"] },
        dismissedAt: "2026-09-18T00:00:00.000Z",
        dismissReason: "已不再需要决策",
      },
    } as unknown as Card;
    const html = renderToStaticMarkup(
      <IssueCard card={dismissed} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />,
    );
    expect(html).toContain("公司 · growth · 已移出决策面 · 移出于 2026-09-18");
    expect(html).not.toContain("kw:context");
    expect(html).toContain("已移出决策面");
  });

  it("预研未完成时不渲染主按钮，改由 Override 二次确认承担决定", () => {
    const notReady = {
      ...pendingIssue,
      payload: { ...(pendingIssue.payload as object), research: { status: "running" } },
    } as unknown as Card;
    const html = renderToStaticMarkup(
      <IssueCard card={notReady} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />,
    );
    expect(html).not.toContain("data-primary");
    expect(html).toContain("预研进行中");
  });

  it("在列容器上暴露当前 tab，供 CSS 把研究 tab 切到单栏阅读列", () => {
    const html = renderToStaticMarkup(
      <IssueCard card={pendingIssue} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />,
    );
    expect(html).toMatch(/<div class="[^"]*" data-tab="summary">/);
  });
});
