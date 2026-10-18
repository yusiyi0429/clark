import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TIssueDecisionHistory } from "@warmap/contracts";
import type { Card } from "@/lib/api/client";
import { MeetingCard } from "./MeetingCard";

const flags = vi.hoisted(() => ({ history: null as TIssueDecisionHistory | null }));
vi.mock("@/components/meeting/useDecisionHistory", () => ({
  DECISION_HISTORY_CHANGED: "decision-history-changed",
  useDecisionHistory: (url: string | null) => url && flags.history
    ? { status: "ready", data: { meetingId: "1", issues: [flags.history] }, error: null, reload: () => undefined }
    : { status: "loading", data: null, error: null, reload: () => undefined },
}));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false, quote: () => undefined, compose: () => undefined }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const ISSUE = "22222222-2222-4222-8222-222222222222";
const MATERIAL = "11111111-1111-4111-8111-111111111111";
const OLD_MEETING = "55555555-5555-4555-8555-555555555555";

const history: TIssueDecisionHistory = {
  issueId: ISSUE,
  issueTitle: "是否把统一验收清单作为销售签约前置条件？",
  issueStatus: "pending",
  effective: [{
    ref: "decision:r-1", issueId: ISSUE, kind: "decision", text: "9 月起新签合同附验收清单", decidedAt: "2026-09-25T02:00:00.000Z",
    decidedBy: { personId: "p2", displayName: "陈珂" }, confirmedVia: "meeting.confirm_item", option: null, status: "effective", statusAt: null,
    statusReason: null, supersededBy: null, revokedBy: null, source: { kind: "meeting-item", meetingId: OLD_MEETING, meetingTitle: "九月经营会", quote: "就这么定" },
    sourceRefs: ["decision:r-1", `meeting:${OLD_MEETING}`],
  }],
  inactive: [{
    ref: "decision:h-0", issueId: ISSUE, kind: "decision", text: "先签约后补清单", decidedAt: "2026-08-10T02:00:00.000Z", decidedBy: null,
    confirmedVia: "imported", option: null, status: "superseded", statusAt: "2026-09-25T02:00:00.000Z", statusReason: null, supersededBy: "decision:r-1",
    revokedBy: null, source: { kind: "imported", importedRef: "8 月经营会纪要 第 3 条" }, sourceRefs: ["decision:h-0"],
  }],
  changes: [{ ref: "fact:f-1", kind: "execution_fact", at: "2026-10-04T03:00:00.000Z", text: "华东两单延期签约", author: null, sourceRef: "销售周报 10/4", relatedDecisionRefs: ["decision:r-1"] }],
  changesSince: "2026-09-25T02:00:00.000Z",
  changesNote: null,
  pending: [
    { ref: `issue:${ISSUE}`, kind: "issue_pending", text: "是否把统一验收清单作为销售签约前置条件？", at: "2026-10-01T02:00:00.000Z",
      options: [{ id: "A", label: "先确定验收清单再签约" }, { id: "B", label: "先签约，交付时逐单协商" }], source: null, note: "本次待判断，尚未形成决定。" },
    { ref: `outcome:${OLD_MEETING}#d-9`, kind: "outcome_candidate", text: "清单改为分级前置", at: "2026-09-25T02:00:00.000Z", options: [],
      source: { kind: "meeting-item", meetingId: OLD_MEETING, meetingTitle: "九月经营会" }, note: "会后候选尚未经 CEO 确认，不是决定。" },
  ],
  relatedMeetings: [{ id: OLD_MEETING, title: "九月经营会", status: "held", scheduledAt: "2026-09-25T02:00:00.000Z" }],
};

function issueCard(payload: Record<string, unknown> = {}, actions: Card["actions"] = [
  { actionId: "act-decide", actionType: "issue.decide", label: "直接决定" },
  { actionId: "act-dismiss", actionType: "issue.dismiss", label: "移出议题" },
]): Card {
  return {
    schemaVersion: 1, id: `issue:${ISSUE}`, version: 3, kind: "issue", objectRef: { type: "issue", id: ISSUE, version: 3 },
    title: "是否把统一验收清单作为销售签约前置条件？",
    payload: {
      origin: "dri", originRef: null, status: "pending", location: { level: "company", relatedBattlefieldIds: [] },
      urgency: { level: "red", decisionBy: "2026-10-12T00:00:00.000Z" },
      research: { status: "ready", doc: {
        summary: "清单前置能减少交付争议，但会推迟两份大单。",
        options: [{ id: "A", label: "先确定验收清单再签约", consequences: ["签约推迟约两周"] }, { id: "B", label: "先签约，交付时逐单协商", consequences: ["交付争议继续"] }],
        evidence: [{ quote: "平均上线周期 21 天", sourceTitle: "九月经营基线" }], unknowns: ["客户对拒绝项的接受程度"], sources: [],
      } },
      receipts: [], dismissedAt: null, dismissReason: null, ...payload,
    },
    actions,
  } as unknown as Card;
}

const entry = (id: string, kind: string, title: string, body: string, sourceRefs: string[], extra: Record<string, unknown> = {}) =>
  ({ id, kind, title, body, sourceRefs, ...extra });

const participants = [
  { personId: "p1", displayName: "林晓", roles: ["dri"], sourceRef: "person:p1", updatedAt: "2025-09-01" },
  { personId: "p2", displayName: "陈珂", roles: ["ceo"], sourceRef: "person:p2", updatedAt: "2025-09-01" },
];

function meetingCard(payloadOverrides: Record<string, unknown>, actions: Card["actions"] = []): Card {
  return {
    schemaVersion: 1, id: "meeting:1", version: 1, kind: "meeting", objectRef: { type: "meeting", id: "1", version: 1 }, title: "验收清单决策会",
    payload: {
      status: "scheduled", scheduledAt: "2026-10-10T02:00:00.000Z", endsAt: "2026-10-10T03:00:00.000Z", endedAt: null, recording: null,
      leadDriId: "p1", ceoParticipantId: "p2", participants, issueIds: [], originRef: "meeting:1",
      preflight: {
        status: "ready", pendingSince: null, runId: null, entries: [], basis: "证据边界", brief: "简报", error: null, generatedAt: "2026-10-09T00:00:00.000Z",
        readiness: "revise", summary: { criticalIssue: "清单是否刚性前置", priorityAction: "先确认两家客户的拒绝项" },
        taskDefinition: { materialPurpose: "材料目的", reviewPurpose: "确认验收清单是否前置", primaryRole: "decision_request", secondaryRole: null,
          maturity: "decision_ready", readerAction: "拍板", nonGoal: "非目标" },
      },
      draft: { readIssueIds: [], carriedIssueIds: [], checkedEntryIds: [], editsByEntryId: {}, supplementRequests: [], note: "" },
      transcript: null, transcriptCandidate: null, outcome: null, materials: [],
      ...payloadOverrides,
    },
    actions,
  } as unknown as Card;
}

function meeting(payload: Record<string, unknown> = {}, actions: Card["actions"] = []): Card {
  const base = meetingCard({}).payload as { preflight: Record<string, unknown> };
  return meetingCard({
    issueIds: [ISSUE],
    preflight: {
      ...base.preflight,
      entries: [
        entry("e1", "core_judgment", "清单可以前置，但要分级", "大单按分级清单前置，小单照旧。", [`issue:${ISSUE}`, `material:${MATERIAL}@v2#p2`]),
        entry("e2", "meeting_question", "清单是否刚性前置", "是否自 10/15 起所有新签合同必须附清单？", [`issue:${ISSUE}`], {
          ceoDecision: { whyNow: "10/12 起 4 份合同进入法务定稿", whyCeo: "改变 9/25 已确认的审批规则", delayCost: "4 份合同按旧条款签出",
            options: [{ label: "先确定验收清单再签约", impact: "大单签约可能推迟" }, { label: "分级前置", impact: "例外条款逐条审批" }] },
        }),
        entry("e3", "risk_calibration", "两家大客户可能流失", "客户不接受清单前置。", ["discussion:88"]),
        entry("e4", "next_step", "先和两家客户确认拒绝项", "本周内由销售负责人确认。", [`issue:${ISSUE}`]),
      ],
      inputCoverage: { background: "available", purpose: "derived", sourceMaterial: "available", relatedMeeting: "available",
        groupMaterials: "available", discussions: "available", decisionHistory: "available",
        evidence: { collectedAt: "2026-10-09T01:00:00.000Z", viewerId: "p2", legacyMaterials: [], discussionMessageIds: [88], discussionMaxId: 88,
          decisionRefs: ["decision:r-1"], inactiveDecisionRefs: ["decision:h-0"], skippedObjects: 0,
          materials: [{ id: MATERIAL, objectType: "issue", objectId: ISSUE, fileName: "交付周报.md", format: "markdown", version: 2, state: "used", truncated: false, sourceRef: `material:${MATERIAL}@v2` }] } },
    },
    ...payload,
  }, actions);
}

const render = (value: Card, collection: Card[] = [value, issueCard()], readOnly = false) => renderToStaticMarkup(
  <MeetingCard card={value} collection={collection} onCard={() => undefined} onNavigate={() => undefined} readOnly={readOnly} />,
);
/** 只看给人读的字：去掉标签和属性。 */
const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ");

beforeEach(() => {
  flags.history = history;
});

describe("会议页按议题收拢（feedback 15）", () => {
  it("每个议题一块：首屏核心判断，往下依次是历史与变化、事实与依据、选项与后果、建议、一号位决定、实际结果", () => {
    const html = render(meeting());
    const block = html.slice(html.indexOf(`id="issue-${ISSUE}"`));
    expect(block).toContain(`data-outline="issue:${ISSUE}"`);
    const order = ["核心判断", "清单可以前置，但要分级", "待一号位判断", "历史与变化", "事实与依据", "选项与后果", "建议", ">一号位决定<", "实际结果"]
      .map((label) => block.indexOf(label));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // CEO 级问题：决策时机、需一号位决定的原因、延迟代价写在首屏；建议标明未确认，不是决定。
    for (const text of ["10/12 起 4 份合同进入法务定稿", "改变 9/25 已确认的审批规则", "4 份合同按旧条款签出", "未确认，不是决定"]) expect(block).toContain(text);
    // 风险条目只指向群讨论，单议题会议时也归这个议题，放在事实与依据里。
    expect(block.indexOf("两家大客户可能流失")).toBeGreaterThan(block.indexOf("事实与依据"));
    // 会议概况只放不专属议题的事：预审结论、资料、边界。
    expect(html.indexOf('data-outline="overview"')).toBeLessThan(html.indexOf(`id="issue-${ISSUE}"`));
  });

  it("三层历史分开：仍有效的历史决定、此后实际变化、本次待判断；被替代的收在折叠里，写明不再约束；会后候选不冒充决定", () => {
    const html = render(meeting());
    for (const text of ["仍有效的历史决定", "9 月起新签合同附验收清单", "此后实际变化", "华东两单延期签约", "本次待判断", "会后候选尚未经 CEO 确认，不是决定。"]) expect(html).toContain(text);
    expect(html).toMatch(/<details[^>]*data-layer="inactive"[^>]*><summary>已被替代或撤回（不再约束） · 1 条<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*data-layer="inactive"[^>]*open/);
    // 相较上次：指出上一次仍有效的决定和之后的变化数。
    expect(html).toContain("相较上次");
    expect(html).toContain("之后有 1 项实际变化");
    // 历史条目有锚点，依据能直接定位过来。
    expect(html).toContain(`id="history-${ISSUE}-decision-r-1"`);
  });

  it("依据是可以打开的按钮：材料写文件名、引用版本和段落；页面上不露内部编号", () => {
    const html = render(meeting());
    expect(html).toMatch(new RegExp(`<button[^>]*data-source-ref="material:${MATERIAL}@v2#p2"[^>]*>《交付周报.md》 · 第 2 版 · 第 2 段`));
    expect(html).toContain('data-source-ref="discussion:88"');
    const text = visibleText(html);
    for (const internal of [ISSUE, MATERIAL, "material:", "decision:", "discussion:", "issue.decide"]) expect(text).not.toContain(internal);
  });

  it("正式版（非演示）不在会议页直接决定：没有决定入口也不写说明，会前准备操作保留", () => {
    const html = render(meeting());
    expect(html).not.toContain(">按此决定<");
    expect(html).not.toContain("决定由会后结论确认生效。");
    expect(html).toContain("已阅");
    expect(html).toContain("带到会议");
  });

  it("资料在预审之后更新：提示预审基于旧版本，并给出原生「重新预审」", () => {
    const stale = { materials: [{ id: MATERIAL, fileName: "交付周报.md", objectType: "issue", objectId: ISSUE, usedVersion: 2, currentVersion: 3, change: "updated" }], newDiscussionCount: 0 };
    const base = meeting().payload as { preflight: Record<string, unknown> };
    const regenerate = [{ actionId: "act-regen", actionType: "meeting.regenerate_preflight", label: "重新预审" }] as Card["actions"];
    const html = render(meeting({ preflight: { ...base.preflight, staleInputs: stale } }, regenerate));
    expect(html).toContain("资料已更新：《交付周报.md》预审基于 v2，当前已是 v3。可重新预审。");
    expect(html).toContain("用最新资料重新预审");
    // 依据按钮也写出已有新版。
    expect(html).toContain("《交付周报.md》 · 第 2 版 · 第 2 段 · 已有新版");
    expect(render(meeting({ preflight: { ...base.preflight, staleInputs: stale } }))).not.toContain("用最新资料重新预审");
  });
});

describe("目录（feedback 10）", () => {
  it("宽屏是左侧吸顶目录，窄屏收成一颗「目录」钮；目录按会议概况 → 议题 → 会议层面列出", () => {
    const html = render(meeting());
    expect(html).toContain('data-toc-bar="true"');
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*?目录/);
    expect(html).toContain('aria-label="议题目录"');
    const nav = html.slice(html.indexOf('aria-label="议题目录"'));
    expect(nav.indexOf("会议概况")).toBeLessThan(nav.indexOf("是否把统一验收清单作为销售签约前置条件？"));
    expect(html).toContain('data-toc="true"');
  });

  it("成员只读视图不出目录，也没有决定入口", () => {
    const html = render(meeting(), undefined, true);
    expect(html).not.toContain("data-toc-bar");
    expect(html).not.toContain("按此决定");
  });
});

describe("会后：会上形成的结论回到议题块里确认", () => {
  const item = (id: string, kind: string, issueId: string | null, extra: Record<string, unknown> = {}) =>
    ({ id, kind, text: `${id} 的内容`, quote: `${id} 原话`, turnId: "t1", speakerId: "p1", ownerPersonId: null, issueId, judgmentKind: null, parentItemId: null, review: { status: "pending" }, ...extra });

  it("指向议题的决定候选在议题块里，带原生确认 / 忽略；没有议题的进「其他事项」", () => {
    const held = meeting({
      status: "held",
      transcript: { turns: [{}, {}] },
      outcome: { status: "ready", pendingSince: null, startedAt: null, runId: null, previousRunIds: [], error: null, summary: "定了分级前置。", warnings: [], extractedAt: "2026-10-09T08:00:00.000Z",
        items: [item("d1", "decision", ISSUE), item("a1", "todo", null, { ownerPersonId: "p1" }), item("s1", "strategic", null, { title: "华东改为主战场", brief: "预算向华东倾斜。" })] },
    }, [
      { actionId: "c-d1", actionType: "meeting.confirm_item", label: "确认", itemId: "d1" },
      { actionId: "x-d1", actionType: "meeting.dismiss_item", label: "忽略", itemId: "d1" },
    ]);
    const html = render(held, [held, issueCard()]);
    const block = html.indexOf(`id="issue-${ISSUE}"`);
    const others = html.indexOf('data-outline="others"');
    expect(block).toBeGreaterThan(-1);
    expect(others).toBeGreaterThan(block);
    const decision = html.indexOf('id="outcome-d1"');
    expect(decision).toBeGreaterThan(block);
    expect(decision).toBeLessThan(others);
    expect(html.slice(decision, others)).toMatch(/data-variant="confirm"[^>]*>确认</);
    expect(html.indexOf('id="outcome-a1"')).toBeGreaterThan(others);
    expect(html.indexOf("华东改为主战场")).toBeGreaterThan(others);
    expect(html).toContain("会上形成的结论");
    expect(html).not.toContain("未确认的候选不构成决定");
    // 会后目录：纪要 → 议题 → 其他 → 原文。
    expect(html).toContain('aria-label="会后目录"');
  });

  it("原话里的 Markdown 表格行改写成一句、和条目重复时不再摆两遍；过了截止的待办标「已过期」", () => {
    const held = meeting({
      status: "held",
      transcript: { turns: [{}, {}] },
      outcome: { status: "ready", pendingSince: null, startedAt: null, runId: null, previousRunIds: [], error: null, summary: "", warnings: [], extractedAt: "2026-10-09T08:00:00.000Z",
        items: [
          item("d1", "decision", null, { text: "战略表达：不再使用“上位战略”", quote: "| 战略表达 | 不再使用“上位战略” |" }),
          item("d2", "decision", null, { text: "统一区分三层", quote: ["| **议题** | **确认结论** |", "|-|-|", "| 报告写法 | 结论前置 |"].join(String.fromCharCode(10)) }),
          item("a1", "todo", null, { text: "形成三个版本（时间：预计 2026 年 8 月初）", ownerPersonId: "p1" }),
          item("a2", "todo", null, { text: "上线评审", dueDate: "2099-01-01", ownerPersonId: "p1" }),
        ] },
    });
    const html = render(held, [held]);
    expect(html).not.toContain("| 战略表达 |");
    expect(html).not.toMatch(/\|\s*-\s*\|/);
    expect(html).toContain("报告写法：结论前置");
    const d1 = html.slice(html.indexOf('id="outcome-d1"'), html.indexOf('id="outcome-d2"'));
    expect(d1).not.toContain("<blockquote");
    const a1 = html.slice(html.indexOf('id="outcome-a1"'), html.indexOf('id="outcome-a2"'));
    expect(a1).toContain("已过期");
    expect(html.slice(html.indexOf('id="outcome-a2"'))).not.toContain("已过期");
  });
});
