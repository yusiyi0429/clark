import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { IssueCard } from "./IssueCard";

// useCardAction 需要 Next 路由上下文；这里只渲染静态标记。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const render = (card: Card) =>
  renderToStaticMarkup(<IssueCard card={card} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />);

/** 三个状态共用同一三栏布局：左栏判断与决策路径、中栏研究报告、右栏议题对话。 */
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
    location: { level: "company", relatedBattlefieldIds: ["growth"] },
    urgency: { level: "red", decisionBy: "2026-10-01T00:00:00.000Z" },
    research: {
      status: "ready",
      doc: {
        summary: "竞对在东南亚的履约时效已领先约 2 天。",
        options: [{ id: "A", label: "追加 40% 预算", consequences: ["履约时效回到持平"] }],
        evidence: [{ quote: "竞对履约 1.8 天", sourceTitle: "渠道周报", sourceUrl: "https://example.com/report" }],
        unknowns: ["补贴能否换来复购"],
        sources: [{ title: "渠道周报", url: "https://example.com/report" }],
      },
    },
    receipts: [],
    dismissedAt: null,
    dismissReason: null,
  },
  actions: [{ actionType: "issue.dismiss" }],
} as unknown as Card;

describe("Issue 三栏工作台", () => {
  it("pending 用单页三栏同时给出判断、研究报告与议题对话，不再渲染决定模块", () => {
    const html = render(pendingIssue);
    expect(html).toContain('data-testid="issue-workspace"');
    expect(html).toContain('data-status="pending"');
    expect(html).toContain("当前判断");
    expect(html).toContain("竞对在东南亚的履约时效已领先约 2 天。");
    expect(html).toContain("决策路径");
    expect(html).toContain("移出决策面");
    expect(html).toContain("研究报告");
    expect(html).toContain('data-readiness="ready"');
    expect(html).toContain("选择与后果");
    expect(html).toContain("证据");
    expect(html).toContain("还没弄清");
    expect(html).toContain("来源");
    expect(html).toContain('data-testid="meeting-chat-sidebar"');
    // 决定只能由 Meeting Outcome 产生，Web 不再提供直接决定 / Override 入口。
    expect(html).not.toContain("直接决定");
    expect(html).not.toContain("data-tab");
  });

  it("decided 保留当前判断与已生效决定的撤回入口", () => {
    const decided = {
      ...pendingIssue,
      payload: {
        ...(pendingIssue.payload as object),
        status: "decided",
        receipts: [
          {
            id: "receipt:1",
            actionType: "issue.decide",
            effectRef: "issue:1",
            decisionText: "追加 40% 预算并绑定季度复购考核。",
            researchStatusAtDecision: "ready",
            override: false,
            createdAt: "2026-09-20T00:00:00.000Z",
            revokedAt: null,
            revokeReason: null,
          },
        ],
      },
      actions: [{ actionType: "issue.revoke_receipt", itemId: "receipt:1" }],
    } as unknown as Card;
    const html = render(decided);
    expect(html).toContain("当前判断");
    expect(html).toContain("已生效决定");
    expect(html).toContain("追加 40% 预算并绑定季度复购考核。");
    expect(html).toContain("撤回决定");
    expect(html).not.toContain("决策路径");
  });

  it("dismissed 在左栏给出已移出终态与恢复入口，并隐藏内部 kw 标识", () => {
    const dismissed = {
      ...pendingIssue,
      payload: {
        ...(pendingIssue.payload as object),
        status: "dismissed",
        location: { level: "company", relatedBattlefieldIds: ["kw:context", "growth"] },
        dismissedAt: "2026-09-18T00:00:00.000Z",
        dismissReason: "已不再需要决策",
      },
      actions: [{ actionType: "issue.restore" }],
    } as unknown as Card;
    const html = render(dismissed);
    expect(html).toContain("公司 · growth · 已移出决策面 · 移出于 2026-09-18");
    expect(html).not.toContain("kw:context");
    expect(html).toContain("已不再需要决策");
    expect(html).toContain("恢复到待处理");
  });

  it("预研失败时在中栏显示错误与重试按钮", () => {
    const failed = {
      ...pendingIssue,
      payload: {
        ...(pendingIssue.payload as object),
        research: { status: "failed", error: { code: "RESEARCH_FAILED", message: "上游超时", at: "2026-09-19T00:00:00.000Z" } },
      },
      actions: [{ actionType: "issue.retry_research" }],
    } as unknown as Card;
    const html = render(failed);
    expect(html).toContain("RESEARCH_FAILED：上游超时");
    expect(html).toContain("重试预研");
    expect(html).toContain('data-readiness="blocked"');
  });
});
