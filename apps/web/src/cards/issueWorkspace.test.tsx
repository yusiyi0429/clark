import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import { IssueCard } from "./IssueCard";

// useCardAction 需要 Next 路由上下文；这里只渲染静态标记。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const battlefield = {
  schemaVersion: 1,
  id: "battlefield:growth",
  version: 1,
  kind: "battlefield",
  objectRef: { type: "battlefield", id: "growth", version: 1 },
  title: "增长战场",
  payload: { battlefieldId: "growth" },
  actions: [],
} as unknown as Card;

const render = (card: Card, homeCards: Card[] = [battlefield]) =>
  renderToStaticMarkup(
    <WorkspaceTestProvider api={{ homeCards }}>
      <IssueCard card={card} collection={[]} onCard={() => undefined} onNavigate={() => undefined} />
    </WorkspaceTestProvider>,
  );

/** 议题工作区（clark issue-workspace）：玻璃页头 + 「总结与判断 / 研究与依据」页签；对话在外壳右侧的对话列。 */
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
    location: { level: "battlefield", battlefieldId: "growth" },
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

const meeting = {
  schemaVersion: 1,
  id: "meeting:m1",
  version: 1,
  kind: "meeting",
  objectRef: { type: "meeting", id: "m1", version: 1 },
  title: "渠道预算会",
  payload: {
    status: "scheduled",
    scheduledAt: "2026-09-24T07:00:00.000Z",
    leadDriId: "p1",
    participants: [{ personId: "p1", displayName: "白田田" }],
    issueIds: ["1"],
  },
  actions: [],
} as unknown as Card;

describe("议题工作区", () => {
  it("页头按 clark：眉题写阶段与战场名称（不打印原始 id），圆形关闭写明回到原位置", () => {
    const html = render(pendingIssue);
    expect(html).toContain('data-testid="issue-workspace"');
    expect(html).toContain('data-status="pending"');
    expect(html).toContain("与你一起想 · 增长战场 · 决定期限 2026-10-01");
    expect(html).toContain('data-context-mark="issue"');
    expect(html).toContain('aria-label="关闭议题，返回原位置"');
    expect(html).toContain("data-close-view");
    expect(html).not.toContain(">growth<");
  });

  it("总结与判断：当前判断可追问，备选方向编号，依据、还没弄清的，决策路径与移出是天枢独有的块", () => {
    const html = render(pendingIssue);
    expect(html).toContain("总结与判断");
    expect(html).toContain("研究与依据");
    expect(html).toContain("当前判断");
    expect(html).toContain("竞对在东南亚的履约时效已领先约 2 天。");
    expect(html).toContain("追问这条判断");
    expect(html).toContain("值得一起推敲的方向");
    expect(html).toContain(">01<");
    expect(html).toContain("追加 40% 预算");
    expect(html).toContain("判断的依据");
    expect(html).toContain("还没弄清的");
    expect(html).toContain("补贴能否换来复购");
    expect(html).toContain("雷达升级 · 预研已完成");
    expect(html).toContain("决策路径");
    expect(html).toContain("移出决策面");
    expect(html).not.toContain('data-testid="meeting-chat-sidebar"');
    // 决定只能由 Meeting Outcome 产生，Web 不提供直接决定 / Override 入口。
    expect(html).not.toContain("直接决定");
  });

  it("已排会议时：会议标记、会议安排条、讨论改为「带到会议讨论」", () => {
    const html = render(pendingIssue, [battlefield, meeting]);
    expect(html).toContain('data-context-mark="meeting"');
    expect(html).toContain("已安排会议 · 增长战场");
    expect(html).toContain('aria-label="议题会议安排"');
    expect(html).toContain("15:00");
    expect(html).toContain("主责 DRI · 白田田");
    expect(html).toContain("带到会议讨论");
  });

  it("decided：讨论区是绿色会议结论，保留撤回入口，不再给决策路径", () => {
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
    expect(html).toContain("已形成结论");
    expect(html).toContain("会议结论");
    expect(html).toContain("这是会议中形成并回传的结论。");
    expect(html).toContain("追加 40% 预算并绑定季度复购考核。");
    expect(html).toContain("撤回决定");
    expect(html).not.toContain("决策路径");
  });

  it("dismissed：摘要顶部给出已移出与恢复入口", () => {
    const dismissed = {
      ...pendingIssue,
      payload: {
        ...(pendingIssue.payload as object),
        status: "dismissed",
        dismissedAt: "2026-09-18T00:00:00.000Z",
        dismissReason: "已不再需要决策",
      },
      actions: [{ actionType: "issue.restore" }],
    } as unknown as Card;
    const html = render(dismissed);
    expect(html).toContain("已移出决策面 · 增长战场");
    expect(html).toContain("已移出决策面：已不再需要决策");
    expect(html).toContain("移出于 2026-09-18");
    expect(html).toContain("恢复到待处理");
  });

  it("预研失败时显示错误与重试按钮", () => {
    const failed = {
      ...pendingIssue,
      payload: {
        ...(pendingIssue.payload as object),
        research: { status: "failed", error: { code: "RESEARCH_FAILED", message: "上游超时", at: "2026-09-19T00:00:00.000Z" } },
      },
      actions: [{ actionType: "issue.retry_research" }],
    } as unknown as Card;
    const html = render(failed);
    expect(html).toContain("上游超时");
    expect(html).not.toContain("RESEARCH_FAILED：");
    expect(html).toContain("重试预研");
    expect(html).toContain("预研尚未产出判断。");
  });

  it("你发起的议题不再被标成负责人提请", () => {
    const html = render({ ...pendingIssue, payload: { ...(pendingIssue.payload as object), origin: "ceo" } } as unknown as Card);
    expect(html).toContain("你发起的议题 · 预研已完成");
    expect(html).not.toContain("DRI 提交");
  });
});
