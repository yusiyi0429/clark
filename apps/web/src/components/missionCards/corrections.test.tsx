import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({ buttons: new Map<string, { onPress?: () => void; isDisabled?: boolean }>() }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useEffect: () => {}, useState: (value: unknown) => [value, () => {}] }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, isDisabled, isIconOnly: _icon, variant: _variant, ...props }: { children?: ReactNode; onPress?: () => void; isDisabled?: boolean; isIconOnly?: boolean; variant?: string; "aria-label"?: string }) => {
  ui.buttons.set(props["aria-label"] ?? String(children), { onPress, isDisabled });
  return <button disabled={isDisabled} {...props}>{children}</button>;
} }));
import { CardDocument } from "./CardDocument";
import type { Correction, CorrectionControls } from "./CorrectionPanel";
import { RoundLine } from "./RoundLine";

type Access = TPersonalMissionCardPayload["correctionAccess"];
const mission = personalPayload.card.missions[0];
const open: Access = { canRequest: true, canApply: false, closedReason: null };
const decider: Access = { canRequest: false, canApply: true, closedReason: null };
const closed: Access = { canRequest: false, canApply: false, closedReason: "月份已过，这张卡只读" };
const fix = (overrides: Partial<Correction> = {}): Correction => ({
  id: "fix-1", missionId: "mission", field: "outcome", original: "形成可核验结果", proposed: "与团队完成共同核验", reason: "客户要求调整口径",
  authorId: "owner", authorName: "白田田", direct: false, status: "pending", decidedBy: null, decidedByName: null, decidedAt: null, note: null,
  appliedVersion: null, stale: false, createdAt: "2026-10-05T06:00:00.000Z", ...overrides,
});
const payload = (access: Access, corrections: Correction[] = []): TPersonalMissionCardPayload => ({
  ...personalPayload, round: { ...personalPayload.round, phase: "confirmed", approver: access.canApply }, corrections, correctionAccess: access,
  card: { ...personalPayload.card, shown: "confirmed", status: "已确定 · 刘明华 10/4 18:00" },
  confirmation: { by: "ceo", byName: "刘明华", at: "2026-10-04T10:00:00.000Z", note: "依赖已核对" },
});
function controls(overrides: Partial<CorrectionControls> = {}) {
  const corrections: CorrectionControls = { draft: null, draftError: "", history: null, rejecting: null, decisionError: null, busy: false, onOpen: vi.fn(), onEdit: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn(), onHistory: vi.fn(), onRejecting: vi.fn(), onDecide: vi.fn(), ...overrides };
  return { onQuote: vi.fn(), onPropose: vi.fn(), onSelect: vi.fn(), corrections };
}
const render = (data: TPersonalMissionCardPayload, props = controls()) => renderToStaticMarkup(<CardDocument payload={data} controls={props} />);
const draft = { missionId: "mission", field: "outcome" as const, sourceVersion: 1, text: "与团队完成共同核验", reason: "", clientId: "11111111-1111-4111-8111-111111111111" };
beforeEach(() => ui.buttons.clear());

describe("更正入口只看服务端给的权限", () => {
  it.each([
    ["拍板人", decider, "更正", 14],
    ["看得到卡的其他人", open, "申请更正", 14],
    ["都不能更正", { ...open, canRequest: false }, "申请更正", 0],
  ] as const)("%s", (_who, access, verb, count) => {
    const html = render(payload(access));
    expect((html.match(new RegExp(`>${verb}</button>`, "g")) ?? []).length).toBe(count);
    if (count) expect(html).toContain(`aria-label="${verb}：战役结果"`);
    if (verb === "申请更正") expect(html).not.toContain(">更正</button>");
  });
  it("点入口把个人任务和字段交给页面打开草稿", () => {
    const props = controls();
    render(payload(open), props);
    ui.buttons.get("申请更正：战役结果")!.onPress!();
    expect(props.corrections.onOpen).toHaveBeenCalledWith(mission, "outcome");
  });
  it("月份已过时正文上方写只读说明，入口消失；讨论期不写这行", () => {
    const html = render(payload(closed));
    expect(html).toContain("月份已过，这张卡只读");
    expect(html.indexOf("月份已过，这张卡只读")).toBeLessThan(html.indexOf("任务细节"));
    expect(html).not.toContain(">更正</button>");
    expect(html).not.toContain(">申请更正</button>");
    const discussing = renderToStaticMarkup(<CardDocument payload={personalPayload} controls={controls()} />);
    expect(discussing).not.toContain("还没确定");
    expect(discussing).not.toContain(">申请更正</button>");
  });
});

describe("字段下方的内联编辑", () => {
  it("申请更正：预填文字、必填一行原因，缺原因不能提交；只在打开的字段下出现", () => {
    const props = controls({ draft });
    const html = render(payload(open), props);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain("申请更正：战役结果");
    expect(html).toContain(">与团队完成共同核验</textarea>");
    expect(html).toContain('<label for="correction-reason-mission-outcome">原因</label><input id="correction-reason-mission-outcome" type="text" maxLength="300" required="" value=""/>');
    expect(html).toContain("提交后等刘明华处理，正文先不变。");
    expect(ui.buttons.get("提交申请更正：战役结果")?.isDisabled).toBe(true);
    render(payload(open), controls({ draft: { ...draft, reason: "   " } }));
    expect(ui.buttons.get("提交申请更正：战役结果")?.isDisabled).toBe(true);
    const filled = controls({ draft: { ...draft, reason: "客户要求调整口径" } });
    render(payload(open), filled);
    expect(ui.buttons.get("提交申请更正：战役结果")?.isDisabled).toBe(false);
    ui.buttons.get("提交申请更正：战役结果")!.onPress!();
    ui.buttons.get("取消申请更正：战役结果")!.onPress!();
    expect(filled.corrections.onSubmit).toHaveBeenCalledOnce();
    expect(filled.corrections.onCancel).toHaveBeenCalledOnce();
  });
  it("拍板人直接更正写明立即生效；列表字段一行一条", () => {
    const html = render(payload(decider), controls({ draft: { ...draft, field: "milestones", text: "待定 · 团队核对\n10/20 · 试用" } }));
    expect(html).toContain("更正：里程碑");
    expect(html).toContain("提交后立即生效，改前改后都会留痕。");
    expect(html).toContain("每行一条");
    expect(html).toContain(">待定 · 团队核对\n10/20 · 试用</textarea>");
  });
  it("失败时保留输入，服务端原因紧跟在输入旁", () => {
    const html = render(payload(open), controls({ draft: { ...draft, reason: "客户要求调整口径" }, draftError: "页面版本已变化，请刷新后重新提交" }));
    expect(html).toContain(">与团队完成共同核验</textarea>");
    expect(html).toContain('value="客户要求调整口径"');
    expect(html).toContain('role="alert">页面版本已变化，请刷新后重新提交</p>');
    expect(html).toContain('aria-describedby="correction-error-mission-outcome"');
  });
});

describe("已更正的小标与历史", () => {
  const applied = [
    fix({ id: "fix-direct", direct: true, authorId: "ceo", authorName: "刘明华", status: "applied", original: "形成可核验结果", proposed: "形成可核验的经营结果", reason: "口径写错", decidedBy: "ceo", decidedByName: "刘明华", decidedAt: "2026-10-06T02:00:00.000Z", appliedVersion: 3, createdAt: "2026-10-06T02:00:00.000Z" }),
    fix({ id: "fix-request", status: "applied", decidedBy: "ceo", decidedByName: "刘明华", decidedAt: "2026-10-05T08:00:00.000Z", appliedVersion: 2 }),
  ];
  it("只有有已采纳更正的字段标「已更正」，点开交给页面展开这个字段", () => {
    const props = controls();
    const html = render(payload(open, [...applied, fix({ id: "fix-other", field: "risk" })]), props);
    expect(html.match(/<span>已更正<\/span>/g)).toHaveLength(1);
    expect(html).toContain('aria-label="已更正：战役结果，查看更正记录"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("的更正记录\"");
    ui.buttons.get("已更正：战役结果，查看更正记录")!.onPress!();
    expect(props.corrections.onHistory).toHaveBeenCalledWith("mission-outcome");
  });
  it("历史写改前改后、原因、谁提谁定和时间；直接更正写谁直接更正", () => {
    const props = controls({ history: "mission-outcome" });
    const html = render(payload(open, applied), props);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="correction-history-mission-outcome"');
    expect(html).toContain('aria-label="战役结果的更正记录"');
    expect(html).toContain("刘明华 直接更正");
    expect(html).toContain("白田田 申请 · 刘明华 已采纳");
    expect(html).toContain("改前"); expect(html).toContain("改后");
    expect(html).toContain("形成可核验的经营结果"); expect(html).toContain("原因：口径写错");
    expect(html).toContain("10/6 10:00"); expect(html).toContain("10/5 16:00");
    ui.buttons.get("已更正：战役结果，收起更正记录")!.onPress!();
    expect(props.corrections.onHistory).toHaveBeenCalledWith(null);
  });
});

describe("待处理与已处理的申请", () => {
  it("非拍板人看到对照、原因和等谁处理，没有处理按钮", () => {
    const html = render(payload(open, [fix()]));
    expect(html).toContain("更正申请 · 等刘明华处理");
    expect(html).toContain("原文"); expect(html).toContain("<del>形成可核验结果</del>");
    expect(html).toContain("<ins>与团队完成共同核验</ins>"); expect(html).toContain("原因：客户要求调整口径");
    expect(html).toContain('id="correction-fix-1"');
    expect(ui.buttons.has("采纳：战役结果")).toBe(false);
  });
  it("拍板人看到采纳与不采纳；不采纳先展开原因", () => {
    const props = controls();
    const html = render(payload(decider, [fix()]), props);
    expect(html).not.toContain("等刘明华处理");
    ui.buttons.get("采纳：战役结果")!.onPress!();
    expect(props.corrections.onDecide).toHaveBeenCalledWith(fix(), "apply");
    ui.buttons.get("不采纳：战役结果")!.onPress!();
    expect(props.corrections.onRejecting).toHaveBeenCalledWith({ id: "fix-1", note: "" });
    expect(props.corrections.onDecide).toHaveBeenCalledOnce();
  });
  it("原文已变化时停用采纳，仍可不采纳", () => {
    const html = render(payload(decider, [fix({ stale: true })]));
    expect(html).toMatch(/<span id="stale-fix-1"[^>]*>原文已变化<\/span>/);
    expect(html).toContain('aria-describedby="stale-fix-1"');
    expect(ui.buttons.get("采纳：战役结果")?.isDisabled).toBe(true);
    expect(ui.buttons.get("不采纳：战役结果")?.isDisabled).toBe(false);
  });
  it("不采纳要写一句原因才能确认；失败原因显示在这条旁边", () => {
    const blank = controls({ rejecting: { id: "fix-1", note: "  " } });
    let html = render(payload(decider, [fix()]), blank);
    expect(html).toContain("不采纳的原因");
    expect(html).toContain('<input id="reject-fix-1" type="text" maxLength="300" autofocus="" value="  "/>');
    expect(ui.buttons.get("确认不采纳：战役结果")?.isDisabled).toBe(true);
    expect(ui.buttons.has("采纳：战役结果")).toBe(false);
    const written = controls({ rejecting: { id: "fix-1", note: "本月先不改" }, decisionError: { correctionId: "fix-1", message: "这条更正已经处理过" } });
    html = render(payload(decider, [fix()]), written);
    expect(ui.buttons.get("确认不采纳：战役结果")?.isDisabled).toBe(false);
    ui.buttons.get("确认不采纳：战役结果")!.onPress!();
    expect(written.corrections.onDecide).toHaveBeenCalledWith(fix(), "reject");
    ui.buttons.get("取消不采纳：战役结果")!.onPress!();
    expect(written.corrections.onRejecting).toHaveBeenCalledWith(null);
    expect(html).toContain('role="alert">这条更正已经处理过</p>');
  });
  it("已处理的申请写结论；月份已过仍在等的写未处理，没有按钮", () => {
    const rejected = fix({ id: "fix-2", status: "rejected", decidedBy: "ceo", decidedByName: "刘明华", decidedAt: "2026-10-06T02:00:00.000Z", note: "本月先不改" });
    expect(render(payload(open, [rejected]))).toContain("未采纳 · 本月先不改");
    const html = render(payload(closed, [fix(), rejected]));
    expect(html).toContain("未处理 · 月份已过");
    expect(html).not.toContain("等刘明华处理");
    expect(ui.buttons.has("采纳：战役结果")).toBe(false);
  });
});

describe("本轮那一行（已确定）", () => {
  const props = { actions: [], viewerId: "ceo", pending: false, onAction: vi.fn(), onSelectCard: vi.fn(), onViewGoals: vi.fn(), onStartProcessing: vi.fn() };
  const applied = [fix({ id: "a", status: "applied", appliedVersion: 2 }), fix({ id: "b", status: "applied", appliedVersion: 3 }), fix({ id: "c" })];
  it("状态句接本卡已采纳的更正数", () => {
    const html = renderToStaticMarkup(<RoundLine {...props} payload={payload(open, applied)} />);
    expect(html).toContain("已确定 · 刘明华 10/4 18:00 · 更正 2 处");
    expect(html).not.toContain(">从第一条开始</button>");
  });
  it("拍板人有待处理申请时写待办，从第一条开始", () => {
    const data = payload(decider, applied);
    const html = renderToStaticMarkup(<RoundLine {...props} payload={{ ...data, round: { ...data.round, todo: "1 条更正申请待你处理", counts: { ...data.round.counts, corrections: 1 } } }} />);
    expect(html).toContain("1 条更正申请待你处理");
    ui.buttons.get("从第一条开始")!.onPress!();
    expect(props.onStartProcessing).toHaveBeenCalledOnce();
  });
  it("月份已过时拍板人不再被催处理", () => {
    const data = payload({ ...closed }, applied);
    // 月份过后服务端不再给待办，只留待处理的计数。
    const html = renderToStaticMarkup(<RoundLine {...props} payload={{ ...data, round: { ...data.round, approver: true, todo: null, counts: { ...data.round.counts, corrections: 1 } } }} />);
    expect(html).toContain("已确定 · 刘明华 10/4 18:00 · 更正 2 处");
    expect(html).not.toContain("待你处理");
    expect(html).not.toContain(">从第一条开始</button>");
  });
});
