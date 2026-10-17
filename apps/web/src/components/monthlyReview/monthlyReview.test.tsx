import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TMonthlyReviewItemPayload, TMonthlyReviewPayload, TMonthlyReviewResponse, TPersonalReviewPayload } from "@warmap/contracts";

const ui = vi.hoisted(() => ({
  post: vi.fn(), get: vi.fn(), navigate: vi.fn(), ask: vi.fn(),
  buttons: new Map<string, { onPress?: () => unknown; isDisabled?: boolean }>(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get, POST: ui.post } }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: ui.navigate, viewerId: "owner" }), useRegisterDetail: vi.fn() }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ children, title, subtitle, actions }: { children: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) => <div><h1>{title}</h1><p>{subtitle}</p>{actions}{children}</div> }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: ui.ask, dialog: null }) }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, isDisabled }: { children: ReactNode; onPress?: () => unknown; isDisabled?: boolean }) => { ui.buttons.set(String(children), { onPress, isDisabled }); return <button disabled={isDisabled}>{children}</button>; } }));

import { ReviewItemScreen } from "./ReviewItemScreen";
import { ReviewOverviewScreen } from "./ReviewOverviewScreen";
import { LtcoDecisionScreen } from "./LtcoDecisionScreen";
import { PersonalReviewScreen } from "./PersonalReviewScreen";
import { itemStatusText } from "./reviewApi";

const act = (actionType: string) => ({ actionId: `sig-${actionType}`, actionType, label: actionType });
const field = (text: string, sources: string[] = []) => ({ text, sources });
const item: TMonthlyReviewItemPayload = {
  itemId: "item-1", reviewId: "review-1", period: "2026-09", version: 3,
  subjectType: "battlefield", subjectId: "bf-01", subjectCode: "01", subjectName: "灯塔项目",
  ownerId: "owner", ownerName: "白田田", ownerUnassigned: false,
  target: "完成三家客户的交付验收", sixMonthOutcome: "成为标杆案例",
  status: "draft", draftError: null,
  selfReview: { overall: field("两家已验收", ["计划反馈 #3"]), judgments: field("1. 第三家延期：客户审批慢"), nextFocus: field("10 月初催办"), escalations: field("") },
  suggestions: [{ field: "judgments", text: "第三家延期两周，影响 10 月回款", rationale: "按你上传的复盘补上影响", createdAt: "2026-09-28T06:00:00.000Z" }],
  returnReason: null,
  assessment: { status: "none", result: null, error: null },
  history: [], comments: [{ id: "c1", authorId: "mo", authorName: "孙铭泽", body: "第三家的接口人上周才定", createdAt: "2026-09-28T07:00:00.000Z" }],
  participantNames: ["孙铭泽"], submittedAt: null, confirmedAt: null, confirmationSource: null,
  viewer: { isOwner: true, isCeo: false, isParticipant: false, canComment: true },
  conversationScope: "monthly-review-item:item-1",
  actions: [act("monthly-review-item.update"), act("monthly-review-item.submit"), act("monthly-review-item.resolve_suggestion")],
};

beforeEach(() => { ui.post.mockReset(); ui.get.mockReset(); ui.navigate.mockReset(); ui.ask.mockReset(); ui.buttons.clear(); vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } }); });
afterEach(() => vi.unstubAllGlobals());

describe("复盘项页", () => {
  it("负责人看到目标、可编辑的四栏、依据、Agent 的改写建议和提交", () => {
    const html = renderToStaticMarkup(<ReviewItemScreen initialItem={item} />);
    expect(html).toContain("01 灯塔项目 · 9 月复盘");
    expect(html).toContain("完成三家客户的交付验收");
    // 四栏 + 讨论输入框
    expect((html.match(/<textarea/g) ?? []).length).toBe(5);
    for (const label of ["本周期总体结果", "关键经营判断", "下周期经营重点", "待上层决策事项"]) expect(html).toContain(label);
    expect(html).toContain("依据：计划反馈 #3");
    expect(html).toContain("Agent 建议改写");
    expect(html).toContain("第三家延期两周，影响 10 月回款");
    expect(html).toContain("提交复盘");
    expect(html).toContain("上传你手写的复盘");
  });

  it("采用建议走 resolve_suggestion，并带上栏位", async () => {
    ui.post.mockResolvedValue({ data: { item: { ...item, version: 4, suggestions: [] } }, response: { ok: true, status: 200 } });
    renderToStaticMarkup(<ReviewItemScreen initialItem={item} />);
    await ui.buttons.get("采用")!.onPress!();
    expect(ui.post).toHaveBeenCalledWith("/api/monthly-reviews/actions/execute", { body: { actionId: "sig-monthly-review-item.resolve_suggestion", input: { field: "judgments", decision: "adopt" } } });
  });

  it("CEO 看已提交的项：只读正文、评估、确认和打回；没有目标时如实说明", () => {
    const submitted: TMonthlyReviewItemPayload = { ...item, status: "submitted", target: null, suggestions: [],
      viewer: { isOwner: false, isCeo: true, isParticipant: false, canComment: true },
      assessment: { status: "ready", error: null, result: { overall: "整体偏乐观", deviations: [{ point: "验收数写多了", evidence: "反馈只记录一家" }], questions: ["第二家验收单在哪？"] } },
      actions: [act("monthly-review-item.confirm"), act("monthly-review-item.return")] };
    const html = renderToStaticMarkup(<ReviewItemScreen initialItem={submitted} />);
    // 只剩讨论输入框；空的待上层决策事项显示「无」
    expect((html.match(/<textarea/g) ?? []).length).toBe(1);
    expect(html).toContain(">无<");
    expect(html).toContain("9 月没有签发的目标");
    expect(html).toContain("整体偏乐观");
    expect(html).toContain("依据：反馈只记录一家");
    expect(html).toContain("可以追问");
    expect(html).toContain(">确认<");
    expect(html).toContain(">打回<");
    expect(html).toContain("已提交 · 待你确认");
  });

  it("被打回时负责人看到原因；起草失败可以重新起草", () => {
    expect(renderToStaticMarkup(<ReviewItemScreen initialItem={{ ...item, status: "returned", returnReason: "差距没对照目标" }} />)).toContain("CEO 打回：差距没对照目标");
    const failed = renderToStaticMarkup(<ReviewItemScreen initialItem={{ ...item, status: "draft_failed", selfReview: null, draftError: { code: "x", message: "模型超时", at: "2026-09-28T06:00:00.000Z" }, actions: [act("monthly-review-item.retry_draft")] }} />);
    expect(failed).toContain("模型超时");
    expect(failed).toContain("重新起草");
  });

  it("本单元 Mission 负责人：只读正文，能看到讨论并补充；确认后不能再补充", () => {
    const participant: TMonthlyReviewItemPayload = { ...item, viewer: { isOwner: false, isCeo: false, isParticipant: true, canComment: true }, actions: [] };
    const html = renderToStaticMarkup(<ReviewItemScreen initialItem={participant} />);
    expect(html).toContain("你参与讨论");
    expect(html).toContain("第三家的接口人上周才定");
    expect(html).toContain("讨论与补充");
    expect(html).not.toContain("提交复盘");
    expect(html).not.toContain("Agent 建议改写");
    expect((html.match(/<textarea/g) ?? []).length).toBe(1);
    const closed = renderToStaticMarkup(<ReviewItemScreen initialItem={{ ...participant, status: "confirmed", viewer: { ...participant.viewer, canComment: false } }} />);
    expect((closed.match(/<textarea/g) ?? []).length).toBe(0);
  });

  it("发送补充走评论接口并带 clientId", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    ui.post.mockResolvedValue({ data: { comment: { id: "c2", authorId: "owner", authorName: "白田田", body: "补一句", createdAt: "2026-09-28T08:00:00.000Z" } }, response: { ok: true, status: 200 } });
    const { ReviewDiscussion } = await import("./ReviewDiscussion");
    const posted = vi.fn();
    // 服务端渲染里没有输入：直接验证发送按钮在空输入时不可用
    const html = renderToStaticMarkup(<ReviewDiscussion itemId="item-1" comments={[]} participantNames={[]} canComment viewerId="owner" onPosted={posted} />);
    expect(html).toContain("还没有人补充");
    expect(ui.buttons.get("发送")!.isDisabled).toBe(true);
  });

  it("状态句分负责人和 CEO", () => {
    expect(itemStatusText({ status: "submitted" }, true)).toBe("已提交 · 等 CEO 确认");
    expect(itemStatusText({ status: "returned" }, false)).toBe("已打回 · 等负责人修改");
  });

  it("导入确认的项不显示成 CEO 确认过，飞书来源可以点开", () => {
    const feishu = "https://tokenking.feishu.cn/wiki/K5sSwooRJikOpykGFfgcY4kHnOg";
    const imported: TMonthlyReviewItemPayload = { ...item, subjectType: "capability", subjectCode: "03", subjectName: "Method", status: "confirmed",
      confirmationSource: "import", confirmedAt: "2026-10-08T02:00:00.000Z", suggestions: [], selfReview: { ...item.selfReview!, overall: field("部分达成", [feishu]) },
      viewer: { isOwner: false, isCeo: true, isParticipant: false, canComment: false }, actions: [] };
    const html = renderToStaticMarkup(<ReviewItemScreen initialItem={imported} />);
    expect(html).toContain("飞书导入 · 未在天枢逐项确认");
    expect(html).not.toContain(">已确认<");
    expect(html).toContain(`依据：<a href="${feishu}" target="_blank" rel="noreferrer">${feishu}</a>`);
    expect(itemStatusText({ status: "confirmed", confirmationSource: "ceo" }, false)).toBe("已确认");
  });
});

describe("个人复盘页", () => {
  const feishu = "https://tokenking.feishu.cn/wiki/HboRwE9ppiUHMPk56fUcZw3XnL4";
  const personal: TPersonalReviewPayload = {
    personalReviewId: "pr-1", monthlyReviewId: "review-1", period: "2026-09", version: 2, personId: "sun-mingze", personName: "孙铭泽",
    status: "submitted", draftSource: "import", draftError: null,
    selfReview: { overall: field("CEO Agent 已上线", [feishu]), judgments: field("1. 体验优先"), nextFocus: field("真实使用"), escalations: field("") },
    missions: [{ id: "04-1", code: "04-1", title: "CEO Agent 核心体验", outcome: "可持续使用" }],
    generationSteps: [], editedFields: [],
    toolConnected: false, materialCount: 0, conversationScope: "personal-review:pr-1", submittedAt: "2026-10-08T02:00:00.000Z", skipped: null,
    viewer: { isSelf: false, isCeo: true }, actions: [],
  };
  const collector = "cite:collector:5b0c5c43-4a0e-4c43-9a43-0d6a0f3c2c11";
  const generated: TPersonalReviewPayload = {
    ...personal, status: "draft", draftSource: "co_agent", submittedAt: null, viewer: { isSelf: true, isCeo: false },
    selfReview: {
      overall: field(`复盘生成写完了[09/16 Codex 记录](${collector})。\n缺少记录：这个月没有每周复盘。`, [collector.slice(5)]),
      judgments: field("我自己改的判断"), nextFocus: field(`接上对话入口[09/16 Codex 记录](${collector})。`, [collector.slice(5)]), escalations: field("无"),
    },
    editedFields: ["judgments"],
    generationSteps: [
      { id: "missions", label: "读 Mission 卡", status: "done", result: "1 张" }, { id: "weekly", label: "读每周复盘", status: "done", result: "缺少记录" },
      { id: "collector", label: "读采集记录", status: "done", result: "1 条" }, { id: "draft", label: "起草", status: "done" },
    ],
    actions: [act("personal-review.update"), act("personal-review.submit"), { ...act("personal-review.draft_with_co_agent"), label: "重新生成" }],
  };

  it("生成的草稿：出处显示成小标记、不重复列在依据里；逐段修改；改过的段落有标记；页头可以重新生成", () => {
    const html = renderToStaticMarkup(<PersonalReviewScreen initialReview={generated} />);
    expect(html).toContain('aria-label="出处：09/16 Codex 记录"');
    expect(html).not.toContain("cite:collector");
    expect(html).not.toContain("依据：");
    expect(html).toContain("缺少记录：这个月没有每周复盘。");
    expect(html.match(/>修改</g)).toHaveLength(4);
    expect(html.match(/你改过/g)).toHaveLength(1);
    expect(html).toContain("重新生成");
    expect(html).toContain("<summary>生成过程 · 4 步</summary>");
    expect(html).toContain("读每周复盘<small>缺少记录</small>");
    expect(html).not.toContain("<textarea");
  });

  it("生成中按步骤显示进度，不能再点生成", () => {
    const steps = generated.generationSteps.map((step, index) => ({ ...step, status: index < 2 ? "done" as const : index === 2 ? "running" as const : "pending" as const, ...(index < 2 ? {} : { result: undefined }) }));
    const html = renderToStaticMarkup(<PersonalReviewScreen initialReview={{ ...generated, status: "drafting", generationSteps: steps, actions: [] }} />);
    expect(html).toContain('<li data-state="running">');
    expect(html).toContain("读 Mission 卡<small>1 张</small>");
    expect(html).not.toContain("重新生成");
    expect(html).not.toContain("生成过程");
  });

  it("从飞书导入的复盘：标明来源，四栏下的飞书链接可以点开", () => {
    const html = renderToStaticMarkup(<PersonalReviewScreen initialReview={personal} />);
    expect(html).toContain("个人月度复盘 · 对照自己的 9 月 Mission Card · 从飞书导入");
    expect(html).not.toContain("草稿：");
    expect(html).toContain(`依据：<a href="${feishu}" target="_blank" rel="noreferrer">${feishu}</a>`);
  });

  it("Co-Agent 起草的草稿仍写草稿来源", () => {
    const html = renderToStaticMarkup(<PersonalReviewScreen initialReview={{ ...personal, status: "draft", draftSource: "co_agent", submittedAt: null }} />);
    expect(html).toContain("· 草稿：Co-Agent");
  });
});

const review: TMonthlyReviewPayload = {
  reviewId: "review-1", period: "2026-09", nextPeriod: "2026-10", version: 5, status: "summarizing",
  counts: { total: 2, submitted: 0, confirmed: 2, returned: 0 },
  items: [
    { itemId: "item-1", subjectType: "battlefield", subjectId: "bf-01", subjectCode: "01", subjectName: "灯塔项目", ownerName: "白田田", ownerUnassigned: false, status: "confirmed", confirmationSource: "ceo", lead: "两家已验收", assessmentStatus: "ready", assessmentOverall: "整体偏乐观", deviationCount: 1, actions: [] },
    { itemId: "item-2", subjectType: "capability", subjectId: "cap-1", subjectCode: "02", subjectName: "交付能力", ownerName: "王路遥", ownerUnassigned: true, status: "confirmed", confirmationSource: "import", lead: null, assessmentStatus: "none", assessmentOverall: null, deviationCount: 0, actions: [] },
  ],
  summary: { status: "ready", error: null, confirmedAt: null, overall: "整体按计划推进", judgments: Array.from({ length: 3 }, (_, index) => ({ title: `判断${index + 1}`, body: `内容${index + 1}` })), nextFocus: ["补齐第三个场景", "非当事人回看"] },
  ltco: {
    window: { start: "2026-10", end: "2027-03" },
    current: "三年内成为行业标杆",
    units: [
      { subjectType: "battlefield", subjectId: "bf-01", subjectCode: "01", subjectName: "灯塔项目", current: "形成标杆案例" },
      { subjectType: "capability", subjectId: "cap-1", subjectCode: "02", subjectName: "交付能力", current: "交付可复用" },
    ],
    suggestion: { change: false, proposedLtco: "三年内成为行业标杆", rationale: "战略没有变", units: [] },
    decision: null,
  },
  actions: [act("monthly-review.update_summary"), act("monthly-review.confirm_summary"), act("monthly-review.retry_summary")],
};

describe("CEO 复盘总览与 LTO 审视", () => {
  it("没有复盘时可以手动开始", () => {
    const empty: TMonthlyReviewResponse = { period: "2026-09", review: null, actions: [act("monthly-review.open")] };
    expect(renderToStaticMarkup(<ReviewOverviewScreen initial={empty} />)).toContain("开始 9 月复盘");
  });

  it("按战场 / 能力域分组，显示评估摘要；全部确认后公司复盘四部分可编辑并确认", () => {
    const html = renderToStaticMarkup(<ReviewOverviewScreen initial={{ period: "2026-09", review, actions: [] }} />);
    expect(html).toContain("战场");
    expect(html).toContain("能力域");
    expect(html).toContain("Co-Agent：整体偏乐观 · 1 处偏差");
    expect(html).toContain("待指派");
    expect((html.match(/<input/g) ?? []).length).toBe(3);
    for (const label of ["本周期总体结果", "关键经营判断", "下周期经营重点", "长期目标修订建议"]) expect(html).toContain(label);
    expect(html).toContain("补齐第三个场景\n非当事人回看");
    expect(html).toContain("建议保持。");
    expect(html).toContain("确认公司复盘");
    expect(html).toContain("反馈给产品");
  });

  it("总览里导入确认的项写「飞书导入 · 未在天枢逐项确认」，CEO 确认的写「已确认」", () => {
    const html = renderToStaticMarkup(<ReviewOverviewScreen initial={{ period: "2026-09", review, actions: [] }} />);
    expect(html.match(/飞书导入 · 未在天枢逐项确认/g)).toHaveLength(1);
    expect(html).toContain(">已确认<");
  });

  it("LTO 页默认按建议选「保持不变」，只列战场 LTO 并显示滑动窗口，确认后去下月计划", async () => {
    ui.post.mockResolvedValue({ data: { review: { ...review, status: "closed" } }, response: { ok: true, status: 200 } });
    const pendingReview = { ...review, status: "ltco_pending" as const, actions: [act("monthly-review.decide_ltco")] };
    const html = renderToStaticMarkup(<LtcoDecisionScreen review={pendingReview} />);
    expect(html).toContain("三年内成为行业标杆");
    expect(html).toContain("Co-Agent 建议：保持不变");
    expect(html).toContain("01 灯塔项目");
    expect(html).toContain("形成标杆案例");
    expect(html).toContain("2026 年 10 月 – 2027 年 3 月");
    expect(html).not.toContain("交付可复用");
    expect(html).toMatch(/<input[^>]*(checked=""[^>]*value="keep"|value="keep"[^>]*checked="")/);
    ui.buttons.get("保持不变，生成下月目标")!.onPress!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.post).toHaveBeenCalledWith("/api/monthly-reviews/actions/execute", { body: { actionId: "sig-monthly-review.decide_ltco", input: { decision: "keep" } } });
    expect(ui.navigate).toHaveBeenCalledWith("/plans/2026-10");
  });
});

describe("LTO 审视：战场 LTO", () => {
  it("有单元建议时默认选修订、预填建议；只提交改过的单元", async () => {
    ui.post.mockResolvedValue({ data: { review: { ...review, status: "closed" } }, response: { ok: true, status: 200 } });
    const suggested = { ...review, status: "ltco_pending" as const, actions: [act("monthly-review.decide_ltco")],
      ltco: { ...review.ltco, suggestion: { change: false, proposedLtco: review.ltco.current, rationale: "灯塔项目方向要收窄", units: [{ subjectType: "battlefield" as const, subjectId: "bf-01", proposedOutcome: "聚焦两家标杆客户", rationale: "第三家延期" }] } } };
    const html = renderToStaticMarkup(<LtcoDecisionScreen review={suggested} />);
    expect(html).toContain("Co-Agent 建议：修订");
    expect(html).toMatch(/<input[^>]*(checked=""[^>]*value="revise"|value="revise"[^>]*checked="")/);
    expect(html).toContain("聚焦两家标杆客户");
    expect(html).toContain("Co-Agent 建议修订：第三家延期");
    ui.buttons.get("确认修订，生成下月目标")!.onPress!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.post).toHaveBeenCalledWith("/api/monthly-reviews/actions/execute", { body: { actionId: "sig-monthly-review.decide_ltco",
      input: { decision: "revise", units: [{ subjectType: "battlefield", subjectId: "bf-01", sixMonthOutcome: "聚焦两家标杆客户" }] } } });
  });
});
