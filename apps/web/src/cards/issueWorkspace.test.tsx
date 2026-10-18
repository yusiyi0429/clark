import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import { IssueCard } from "./IssueCard";

// useCardAction 需要 Next 路由上下文；这里只渲染静态标记。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
// 三层历史由 /api/issues/:id/history 读回；静态渲染里直接给一份读到的结果。
const historyFlag = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/components/meeting/useDecisionHistory", () => ({
  DECISION_HISTORY_CHANGED: "decision-history-changed",
  useDecisionHistory: (url: string | null) => url && historyFlag.value
    ? { status: "ready", data: historyFlag.value, error: null, reload: () => undefined }
    : { status: "loading", data: null, error: null, reload: () => undefined },
}));

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
const renderReadOnly = (card: Card) => renderToStaticMarkup(
  <WorkspaceTestProvider api={{ homeCards: [battlefield] }}>
    <IssueCard card={card} collection={[]} readOnly onCard={() => undefined} onNavigate={() => undefined} />
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
  it("页头沿用会议的紧凑阅读页：阶段与战场名称、返回入口、材料切换格", () => {
    const html = render(pendingIssue);
    expect(html).toContain('data-testid="issue-workspace"');
    expect(html).toContain('data-status="pending"');
    // 页头和正文都按材料排印（globals.css 的 --doc-*，规范 2026-10-12-issue-page-typography）。
    expect(html).toContain('data-type-scale="doc"');
    expect(html).toContain("待决策 · 增长战场 · 决定期限 2026-10-01");
    expect(html).toContain('class="ts-detail-header"');
    expect(html).toContain('id="issue-title"');
    expect(html).toContain("返回总览");
    expect(html).toContain("data-header-tools");
    expect(html).toContain("data-close-view");
    expect(html).not.toContain(">growth<");
  });

  it("总结与判断：当前判断可追问，备选方向编号，待澄清事项，依据；页面里没有决策路径与移出两节", () => {
    const html = render(pendingIssue);
    expect(html).toContain("总结与判断");
    expect(html).toContain("研究与依据");
    // 页头类型切换（SegmentedSwitch）：默认选总结与判断。
    expect(html).toContain('role="radiogroup" aria-label="议题内容"');
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>总结与判断</);
    expect(html).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*>研究与依据</);
    expect(html).toContain("当前判断");
    expect(html).toContain("竞对在东南亚的履约时效已领先约 2 天。");
    expect(html).toContain("追问这条判断");
    expect(html).toContain("备选方案");
    expect(html).toContain(">01<");
    expect(html).toContain("追加 40% 预算");
    expect(html).toContain("判断的依据");
    expect(html).toContain("待澄清事项");
    expect(html).toContain("补贴能否换来复购");
    expect(html).toContain("雷达升级 · 预研已完成");
    expect(html).not.toContain("决策路径");
    expect(html).not.toContain("移出决策面");
    expect(html).not.toContain("安排一场会议");
    expect(html).not.toContain('data-issue-side=');
    expect(html).not.toContain('data-testid="meeting-chat-sidebar"');
    // 决定只能由 Meeting Outcome 产生，Web 不提供直接决定 / Override 入口。
    expect(html).not.toContain("直接决定");
  });

  it("判断的依据在页面最后：排在备选方案、历史、待澄清事项之后", () => {
    const html = render(pendingIssue);
    const evidence = html.indexOf("判断的依据");
    expect(evidence).toBeGreaterThan(0);
    for (const before of ["当前判断", "备选方案", "待澄清事项"]) expect(html.indexOf(before), before).toBeLessThan(evidence);
    // 依据之后没有别的内容节（只剩依据自己的条目）。
    const rest = html.slice(html.lastIndexOf("<h2", evidence));
    expect(rest.match(/<h2/g)?.length).toBe(1);
    expect(rest).not.toContain("待澄清事项");
    expect(rest).not.toContain("历史与变化");
  });

  it("一号位页头：「更多操作」钮在指派旁边；议题已移出 / 已决定，或没有这两个动作时不出现", () => {
    const withMenu = { ...pendingIssue, actions: [{ actionType: "issue.dismiss" }, { actionId: "j1", actionType: "issue.join_meeting", label: "加入会议" }] } as unknown as Card;
    const html = render(withMenu);
    expect(html).toContain('aria-label="更多操作"');
    expect(html.indexOf('aria-label="更多操作"')).toBeGreaterThan(html.indexOf("邀请成员"));
    // 菜单没打开时，两个入口不占页面。
    expect(html).not.toContain("加入已有会议");
    expect(html).not.toContain("移出议题");
    expect(render({ ...pendingIssue, actions: [] } as unknown as Card)).not.toContain('aria-label="更多操作"');
    const decided = { ...withMenu, payload: { ...(pendingIssue.payload as object), status: "decided" } } as unknown as Card;
    expect(render(decided)).not.toContain('aria-label="更多操作"');
    expect(renderReadOnly(withMenu)).not.toContain('aria-label="更多操作"');
  });

  it("已排会议时保留会议安排与「提交会议讨论」", () => {
    const html = render(pendingIssue, [battlefield, meeting]);
    expect(html).toContain('class="ts-detail-header"');
    expect(html).toContain("已安排会议 · 增长战场");
    expect(html).toContain('aria-label="议题会议安排"');
    expect(html).toContain("15:00");
    expect(html).toContain("主持 · 白田田");
    expect(html).toContain("提交会议讨论");
  });

  it("decided（直接决定）：讨论区写「已形成的决定」，保留撤回入口，不再给决策路径和「先讨论」提示", () => {
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
    expect(html).toContain("已形成的决定");
    expect(html).not.toContain("本决定由一号位直接作出。");
    expect(html).not.toContain("会议中形成并回传");
    expect(html).not.toContain("可以先与天枢讨论");
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

  it("一号位发起不再被标成负责人提请", () => {
    const html = render({ ...pendingIssue, payload: { ...(pendingIssue.payload as object), origin: "ceo" } } as unknown as Card);
    expect(html).toContain("一号位发起 · 预研已完成");
    expect(html).not.toContain("DRI 提交");
  });
  it("AI 候选议题的说明行不再写「AI 建议」，只留预研状态；负责人提请的保持原样", () => {
    const ai = render({ ...pendingIssue, payload: { ...(pendingIssue.payload as object), origin: "dri", nature: "ai_suggested" } } as unknown as Card);
    expect(ai).toContain("预研已完成");
    expect(ai).not.toContain("AI 建议");
    expect(ai).not.toContain("负责人提请");
    const dri = render({ ...pendingIssue, payload: { ...(pendingIssue.payload as object), origin: "dri" } } as unknown as Card);
    expect(dri).toContain("负责人提请 · 预研已完成");
  });
  it("雷达升级的议题：页头标题旁有「雷达图标 + 雷达」小标签（读屏「来自雷达」），说明行不再写「AI 建议」；资料包导入的没有", () => {
    const radar = render({ ...pendingIssue, payload: { ...(pendingIssue.payload as object), origin: "radar", nature: "ai_suggested" } } as unknown as Card);
    expect(radar).toMatch(/<span[^>]*data-origin-tag="radar"[^>]*aria-label="来自雷达"[^>]*><svg[^>]*data-origin-radar="true"[^>]*>.*?<\/svg>雷达<\/span>/);
    expect(radar).not.toContain("AI 建议");
    expect(radar).toContain("预研已完成");
    const imported = render({ ...pendingIssue, payload: { ...(pendingIssue.payload as object), origin: "dri", nature: "ai_suggested" } } as unknown as Card);
    expect(imported).not.toContain("data-origin-radar");
    expect(imported).not.toContain("来自雷达");
    const plainRadar = render(pendingIssue as unknown as Card);
    expect(plainRadar).toContain("雷达升级 · 预研已完成");
  });
  it("决定区旁边是历史：仍有效的历史决定、此后实际变化；不再列「本次待判断」卡；被撤回的折叠起来，写明不再约束", () => {
    historyFlag.value = {
      issueId: "1", issueTitle: "是否追加东南亚渠道预算 40%", issueStatus: "pending",
      effective: [{ ref: "decision:h-1", issueId: "1", kind: "decision", text: "Q3 先投 20% 试点", decidedAt: "2026-07-01T02:00:00.000Z",
        decidedBy: { personId: "p-ceo", displayName: "林岚" }, confirmedVia: "imported", option: null, status: "effective", statusAt: null, statusReason: null,
        supersededBy: null, revokedBy: null, source: { kind: "imported", importedRef: "7 月经营会纪要 第 2 条" }, sourceRefs: ["decision:h-1"] }],
      inactive: [{ ref: "decision:r-0", issueId: "1", kind: "decision", text: "暂停东南亚投入", decidedAt: "2026-06-01T02:00:00.000Z", decidedBy: null,
        confirmedVia: "issue.decide", option: null, status: "revoked", statusAt: "2026-06-20T02:00:00.000Z", statusReason: "数据口径有误",
        supersededBy: null, revokedBy: null, source: { kind: "issue-receipt", receiptId: "r-0" }, sourceRefs: ["decision:r-0", "issue:1"] }],
      changes: [{ ref: "feedback:fb-1", kind: "monthly_feedback", at: "2026-09-10T02:00:00.000Z", text: "试点城市复购率 31%", author: null, sourceRef: "9 月阶段反馈" }],
      changesSince: "2026-07-01T02:00:00.000Z", changesNote: null,
      pending: [{ ref: "issue:1", kind: "issue_pending", text: "是否追加东南亚渠道预算 40%", at: "2026-09-20T02:00:00.000Z", options: [{ id: "A", label: "追加 40% 预算" }], source: null, note: "本次待判断，尚未形成决定。" }],
      relatedMeetings: [],
    };
    try {
      const html = render(pendingIssue);
      expect(html.indexOf("备选方案")).toBeLessThan(html.indexOf("历史与变化"));
      expect(html.indexOf("历史与变化")).toBeLessThan(html.indexOf("判断的依据"));
      expect(html).toContain('id="issue-history-title"');
      for (const text of ["仍有效的历史决定", "Q3 先投 20% 试点", "出处：7 月经营会纪要 第 2 条", "此后实际变化", "试点城市复购率 31%"]) {
        expect(html).toContain(text);
      }
      // 「本次待判断」就是这一页本身：不再出现那张「待决定」卡，可选路径只在「备选方案」里。
      for (const text of ["本次待判断", "本次待判断，尚未形成决定。", 'data-layer="pending"', "可选路径："]) expect(html).not.toContain(text);
      expect(html).toMatch(/<details[^>]*data-layer="inactive"[^>]*><summary>已被替代或撤回（不再约束） · 1 条<\/summary>/);
      expect(html).toContain("已撤回");
      expect(html).toContain("数据口径有误");
    } finally {
      historyFlag.value = null;
    }
  });

  it("历史全部为空：整节收成一行「暂无历史决定和后续变化。」，没有节标题和空的分层", () => {
    historyFlag.value = {
      issueId: "1", issueTitle: "是否追加东南亚渠道预算 40%", issueStatus: "pending",
      effective: [], inactive: [], changes: [], changesSince: null, changesNote: "决定之后未获得执行证据（待补）。",
      pending: [{ ref: "issue:1", kind: "issue_pending", text: "是否追加东南亚渠道预算 40%", at: "2026-09-20T02:00:00.000Z", options: [{ id: "A", label: "追加 40% 预算" }], source: null, note: "本次待判断，尚未形成决定。" }],
      relatedMeetings: [],
    };
    try {
      const html = render(pendingIssue);
      expect(html).toMatch(/<section[^>]*data-history-collapsed=""[^>]*><p[^>]*data-history-empty=""[^>]*>暂无历史决定和后续变化。<\/p><\/section>/);
      expect(html).not.toContain('id="issue-history-title"');
      for (const text of ["仍有效的历史决定", "此后实际变化", "本次待判断", "决定之后未获得执行证据", "暂无仍有效的已确认决定"]) expect(html).not.toContain(text);
    } finally {
      historyFlag.value = null;
    }
  });

  it("只有一层有内容时只显示那一层", () => {
    historyFlag.value = {
      issueId: "1", issueTitle: "t", issueStatus: "pending", effective: [], inactive: [], pending: [], relatedMeetings: [],
      changes: [{ ref: "feedback:fb-1", kind: "monthly_feedback", at: "2026-09-10T02:00:00.000Z", text: "试点城市复购率 31%", author: null, sourceRef: "9 月阶段反馈" }],
      changesSince: "2026-07-01T02:00:00.000Z", changesNote: null,
    };
    try {
      const html = render(pendingIssue);
      expect(html).toContain("历史与变化");
      expect(html).toContain("此后实际变化");
      expect(html).not.toContain("仍有效的历史决定");
      expect(html).not.toContain("暂无历史决定和后续变化。");
    } finally {
      historyFlag.value = null;
    }
  });

  it("成员只读视图不读历史分层", () => {
    expect(renderReadOnly({ ...pendingIssue, actions: [] } as unknown as Card)).not.toContain("历史与变化");
  });

  it("加入已有会议收在「更多」里，页面正文不再有加入会议的下拉；说明行不再提「下方安排会议」", () => {
    const meeting = { schemaVersion: 1, id: "meeting:m1", version: 1, kind: "meeting", objectRef: { type: "meeting", id: "m1", version: 1 },
      title: "周五经营会", payload: { status: "scheduled", issueIds: [], scheduledAt: "2025-09-30T02:00:00.000Z" }, actions: [] } as unknown as Card;
    const card = { ...pendingIssue, actions: [{ actionType: "issue.dismiss" }, { actionId: "j1", actionType: "issue.join_meeting", label: "加入会议" }] } as unknown as Card;
    const html = render(card, [battlefield, meeting]);
    expect(html).not.toContain("选择一场待开的会议");
    expect(html).not.toContain("加入已有会议");
    expect(html).not.toContain("可在对话栏与天枢讨论。");
    expect(html).not.toContain("下方安排会议");
    expect(html).not.toMatch(/Meeting|scheduled Meeting/);
  });

  it("成员沿用议题框架和中文标签，只保留追问入口", () => {
    const member = { ...pendingIssue, payload: { ...(pendingIssue.payload as object),
      originRef: { whyNow: "渠道窗口将关闭" } }, actions: [] } as unknown as Card;
    const html = renderReadOnly(member);
    expect(html).toContain("data-header-tools");
    expect(html).toContain("总结与判断");
    expect(html).toContain("决策时机");
    expect(html).toContain("渠道窗口将关闭");
    expect(html).toContain("紧急程度：紧急");
    expect(html).toContain("预研已完成");
    expect(html).toContain("追问这条判断");
    expect(html).not.toContain("邀请成员");
    expect(html).not.toContain("安排一场会议");
  });
});

describe("议题页的会议与结论来源（巡检 P1-5 / P1-10）", () => {
  it("结论块按来源写：会后确认回传的是「会议结论」，直接决定的是「已形成的决定」", async () => {
    const { receiptHeading } = await import("./IssueCard");
    const base = { id: "r", actionType: "issue.decide", effectRef: "e", decisionText: "d", researchStatusAtDecision: "ready", override: false, createdAt: "", revokedAt: null, revokeReason: null };
    const meetingReceipt = { ...base, source: { kind: "meeting-item" as const, meetingId: "m", outcomeItemId: "i" } };
    expect(receiptHeading([meetingReceipt]).title).toBe("会议结论");
    expect(receiptHeading([base]).title).toBe("已形成的决定");
    expect(receiptHeading([base, meetingReceipt]).title).toBe("已形成的决定");
  });

  it("刚加入的会议从本页集合里取（版本新的那份），不等首页刷新", async () => {
    const { mergeMeetingCards } = await import("./IssueCard");
    const old = { id: "meeting:m1", kind: "meeting", version: 1 } as unknown as Card;
    const fresh = { id: "meeting:m1", kind: "meeting", version: 2 } as unknown as Card;
    const other = { id: "meeting:m2", kind: "meeting", version: 1 } as unknown as Card;
    const bf = { id: "battlefield:b", kind: "battlefield", version: 1 } as unknown as Card;
    expect(mergeMeetingCards([bf, old], [fresh, other])).toEqual([bf, fresh, other]);
    expect(mergeMeetingCards([bf, fresh], [old])).toEqual([bf, fresh]);
  });
});
