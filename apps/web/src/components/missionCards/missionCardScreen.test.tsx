import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import type { Card } from "@/lib/api/client";
import type { DocumentControls } from "./CardDocument";
import type { Correction } from "./CorrectionPanel";
import type { ComponentProps } from "react";
import type { RoundLine } from "./RoundLine";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({
  state: [] as unknown[], cursor: 0, controls: null as DocumentControls | null,
  ownerPlan: null as unknown, viewerId: "viewer",
  effects: [] as (() => void | (() => void))[],
  buttons: new Map<string, { onPress?: () => Promise<void> | void; isDisabled?: boolean }>(),
  post: vi.fn(), get: vi.fn(), register: vi.fn(), refresh: vi.fn(), ask: vi.fn(), navigate: vi.fn(), dispatch: vi.fn(),
  roundProps: null as ComponentProps<typeof RoundLine> | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void | (() => void)) => { ui.effects.push(effect); }, useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.state)) ui.state[index] = initial;
    return [ui.state[index], (value: unknown) => { ui.state[index] = typeof value === "function" ? value(ui.state[index]) : value; }];
  } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: ui.refresh }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get, POST: ui.post } }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: ui.navigate, viewerId: ui.viewerId }), useRegisterDetail: ui.register }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: ui.ask, dialog: null }) }));
vi.mock("./useRoundNow", () => ({ useRoundNow: (_at: string, now: string) => Date.parse(now) }));
vi.mock("@heroui/react", () => { const part = ({ children }: { children: ReactNode }) => <>{children}</>; return { Modal: Object.assign(() => null, { Backdrop: part, Container: part, Dialog: part }) }; });
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, isDisabled, "aria-label": label }: { children: ReactNode; onPress?: () => Promise<void> | void; isDisabled?: boolean; "aria-label"?: string }) => { ui.buttons.set(String(children), { onPress, isDisabled }); if (label) ui.buttons.set(label, { onPress, isDisabled }); return <button disabled={isDisabled} aria-label={label}>{children}</button>; } }));
vi.mock("./RoundLine", () => ({ RoundLine: (props: ComponentProps<typeof RoundLine>) => { ui.roundProps = props; return null; } }));
vi.mock("./CardDocument", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CardDocument")>();
  return { ...actual, CardDocument: ({ controls, ownerPlan }: { controls: DocumentControls; ownerPlan?: unknown }) => { ui.controls = controls; ui.ownerPlan = ownerPlan; return <>{controls.proposalEditor?.(personalPayload.card.missions[0], "outcome")}</>; } };
});
import { MissionCardScreen } from "./MissionCardScreen";

const card = { id: "personal-card", kind: "personal-mission-card", payload: personalPayload, actions: [], conversation: { scope: "mission-card:card" } } as unknown as Card;
const mission = personalPayload.card.missions[0];
function render() { ui.cursor = 0; ui.buttons.clear(); return renderToStaticMarkup(<MissionCardScreen initialCard={card} entry="member" />); }
function edit(text: string) {
  const editor = ui.controls!.proposalEditor!(mission, "outcome") as ReactElement<{ children: ReactElement[] }>;
  const textarea = editor.props.children[1] as ReactElement<{ onChange: (event: { target: { value: string } }) => void }>;
  textarea.props.onChange({ target: { value: text } });
  render();
}
async function submit() { ui.buttons.get("提交修改建议")!.onPress!(); await vi.waitFor(() => expect(ui.post).toHaveBeenCalled()); await new Promise((resolve) => setTimeout(resolve, 0)); return render(); }
beforeEach(() => { ui.state = []; ui.cursor = 0; ui.controls = null; ui.ownerPlan = null; ui.viewerId = "viewer"; ui.effects = []; vi.clearAllMocks(); vi.stubGlobal("window", { dispatchEvent: ui.dispatch }); ui.get.mockResolvedValue({ response: { ok: true }, data: { cards: [card] } }); ui.ask.mockResolvedValue(true); });
afterEach(() => vi.unstubAllGlobals());

describe("任务卡建议交互", () => {
  it("拍板人可在页头切换各人的卡；普通卡主人没有人员页签", () => {
    const second = { ...personalPayload.round.cards[0], cardId: "other", ownerId: "other", ownerName: "孙铭泽", line: "待处理 1", placeholder: false };
    const changed = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, cards: [personalPayload.round.cards[0], second] } } } as Card;
    const html = renderToStaticMarkup(<MissionCardScreen initialCard={changed} entry="member" />);
    expect(html).toContain('aria-label="切换任务卡"');
    expect(html).toContain("孙铭泽");
    ui.buttons.get("打开孙铭泽的 Mission Card · 待处理 1")!.onPress!();
    expect(ui.navigate).toHaveBeenCalledWith("/me/mission-cards/other");
    ui.state = []; ui.cursor = 0;
    const ordinary = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, approver: false, cards: [personalPayload.round.cards[0]] } } } as Card;
    expect(renderToStaticMarkup(<MissionCardScreen initialCard={ordinary} entry="member" />)).not.toContain('aria-label="切换任务卡"');
  });
  it("只有卡主人接入个人任务与本月计划页签", () => {
    render();
    expect(ui.ownerPlan).toBeUndefined();
    ui.viewerId = "owner";
    ui.state = [];
    render();
    expect(ui.ownerPlan).toMatchObject({ selected: false, plan: null });
  });
  it("建议提交带当时版本、字段与轮次，成功才清空；同时刷新左侧意见", async () => {
    ui.post.mockResolvedValue({ response: { ok: true } });
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("与团队核验的新结果");
    const html = await submit();
    expect(ui.post).toHaveBeenCalledWith("/api/mission-cards/{cardId}/feedback", expect.objectContaining({ params: { path: { cardId: "card" } }, body: expect.objectContaining({ kind: "suggestion", round: 1, sourceVersion: 1, missionId: "mission", field: "outcome", proposed: "与团队核验的新结果" }) }));
    expect(ui.get).toHaveBeenCalled();
    expect(html).not.toContain("textarea");
    expect(html).toContain("修改建议已记录");
  });
  it("网络失败保留输入，原样重试复用 clientId，编辑后成为新尝试", async () => {
    ui.post.mockRejectedValue(new Error("网络暂时断开"));
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("尚未送达的新结果");
    expect(await submit()).toContain("尚未送达的新结果");
    const first = ui.post.mock.calls[0][1].body.clientId;
    await submit();
    expect(ui.post.mock.calls[1][1].body.clientId).toBe(first);
    edit("修改后的新结果"); await submit();
    expect(ui.post.mock.calls[2][1].body.clientId).not.toBe(first);
  });
  it("版本冲突保留正在写的建议并显示服务端原因", async () => {
    ui.post.mockResolvedValue({ response: { ok: false, status: 409 }, error: { message: "页面版本已变化，请刷新后重新提交" } });
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("待重新核对的输入");
    const html = await submit();
    expect(html).toContain("待重新核对的输入");
    expect(html).toContain("页面版本已变化，请刷新后重新提交");
  });
  it.each([new TypeError("Failed to fetch"), new Error("NetworkError when attempting to fetch resource.")])("断网错误在建议输入旁用中文呈现，不让人滚回页首找失败原因", async (failure) => {
    ui.post.mockRejectedValue(failure);
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("断网时继续保留的建议");
    const html = await submit();
    expect(html).toContain("暂时无法连接服务器，请稍后重试；输入已保留。");
    expect(html).not.toContain(failure.message);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf("</textarea>"));
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf(">提交修改建议</button>"));
    expect(html).toContain('aria-describedby="proposal-error-mission-outcome"');
    expect(html).toContain("断网时继续保留的建议");
  });
  it("划词交给当前任务卡群组并带源版本，超长引用给可操作提示", () => {
    render(); ui.controls!.onQuote(mission, "outcome", "形成可核验结果"); render();
    expect(ui.register.mock.calls.at(-1)![0]).toMatchObject({ scope: "mission-card:card", group: { cardId: "card", viewerId: "viewer", round: 1, reference: { missionId: "mission", field: "outcome", sourceVersion: 1, quote: "形成可核验结果" } } });
    ui.controls!.onQuote(mission, "outcome", "长".repeat(2001));
    expect(render()).toContain("请划选其中一段引用");
  });
});

describe("拍板动作与跨卡处理", () => {
  it("确认成功立即通知常驻成员工作台同步退组，失败不广播", async () => {
    const confirm = { actionId: "confirm", actionType: "mission-round.confirm", label: "确认" };
    render();
    ui.post.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    ui.roundProps!.onAction(confirm, { note: "已完成核对" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.dispatch).not.toHaveBeenCalled();
    ui.post.mockResolvedValueOnce({ response: { ok: true }, data: { cards: [{ ...card, payload: { ...personalPayload, round: { ...personalPayload.round, phase: "confirmed" } } }] } });
    render(); ui.roundProps!.onAction(confirm, { note: "已完成核对" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ui.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "mission-round-changed" }));
  });
  const deciding = { actionId: "signed-decide", actionType: "mission-round.decide", label: "处理意见" };
  const feedback = { id: "feedback-1", actions: [deciding] } as Parameters<NonNullable<DocumentControls["onDecide"]>>[0];
  it("跨卡定位在工作区入场焦点之后落到意见，不被关闭按钮抢走", () => {
    const frames: (() => void)[] = [], focused: string[] = [];
    const target = { focus: () => focused.push("feedback"), scrollIntoView: vi.fn() };
    vi.stubGlobal("document", { getElementById: vi.fn().mockReturnValue(target) });
    vi.stubGlobal("window", { location: { search: "?feedback=feedback-1" }, matchMedia: () => ({ matches: true }), requestAnimationFrame: (callback: () => void) => frames.push(callback), cancelAnimationFrame: vi.fn() });
    render(); ui.effects[0]();
    frames.push(() => focused.push("close"));
    frames.splice(0).forEach((callback) => callback());
    frames.splice(0).forEach((callback) => callback());
    expect(focused).toEqual(["close", "feedback"]);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
  });
  it("决定带签名 token、当前卡及结论，等待响应时重复点击只发一次", async () => {
    let finish!: (value: unknown) => void;
    ui.post.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render();
    ui.controls!.onDecide!(feedback, "accept");
    ui.controls!.onDecide!(feedback, "accept");
    expect(ui.post).toHaveBeenCalledOnce();
    expect(ui.post).toHaveBeenCalledWith("/api/mission-rounds/actions/execute", { body: { actionId: "signed-decide", input: { decision: "accept" }, viewCardId: "card" } });
    finish({ response: { ok: true }, data: { cards: [card] } });
    await new Promise((resolve) => setTimeout(resolve, 0)); render();
    expect(ui.controls!.decisionError).toBeNull();
  });
  it("处理冲突采用服务端新卡与原因，在原意见旁显示，不显示假成功", async () => {
    const latest = { ...card, version: 2, payload: { ...personalPayload, card: { ...personalPayload.card, status: "候选版本 · 相比草稿 1 处改动" } } };
    ui.post.mockResolvedValue({ response: { ok: false, status: 409 }, error: { message: "同一字段已采纳另一条", latestCard: latest } });
    render(); ui.controls!.onDecide!(feedback, "accept");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const html = render();
    expect(ui.controls!.decisionError).toEqual({ feedbackId: "feedback-1", message: "同一字段已采纳另一条" });
    expect(ui.roundProps!.payload.card.status).toContain("1 处改动");
    expect(html).not.toContain("已重新开启");
  });
  it("首条待处理可落在另一张卡，使用服务端给的意见id跨卡定位", () => {
    render();
    ui.state[0] = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, phase: "reviewing", cards: [{ ...personalPayload.round.cards[0], pending: 0 }, { ...personalPayload.round.cards[0], cardId: "other-card", pending: 2, firstPendingFeedbackId: "first-feedback" }] } } };
    render(); ui.roundProps!.onStartProcessing!();
    expect(ui.navigate).toHaveBeenCalledExactlyOnceWith("/me/mission-cards/other-card?feedback=first-feedback");
  });
  it("核对草稿在失败时保留，重开弹窗写轮次和预计截止，成功才清空", async () => {
    render(); ui.roundProps!.onNoteChange!("双方已核对依赖。"); render();
    expect(ui.roundProps!.note).toBe("双方已核对依赖。");
    const reopen = { actionId: "reopen", actionType: "mission-round.reopen", label: "重新开启" };
    ui.post.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    ui.roundProps!.onAction(reopen);
    await new Promise((resolve) => setTimeout(resolve, 0)); render();
    expect(ui.roundProps!.note).toBe("双方已核对依赖。");
    expect(ui.ask.mock.calls[0][0]).toContain("第 2 轮");
    expect(ui.ask.mock.calls[0][0]).toContain("预计 10/3 08:00");
    ui.post.mockResolvedValueOnce({ response: { ok: true }, data: { cards: [{ ...card, payload: { ...personalPayload, round: { ...personalPayload.round, round: 2 } } }] } });
    ui.roundProps!.onAction(reopen);
    await new Promise((resolve) => setTimeout(resolve, 0)); render();
    expect(ui.roundProps!.note).toBe("");
  });
  it("别人重开刷新到新窗口后，旧核对草稿不跨轮显示", () => {
    render(); ui.roundProps!.onNoteChange!("旧轮结论"); render();
    ui.state[0] = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, round: 2 } } };
    render(); expect(ui.roundProps!.note).toBe("");
  });
});

describe("已确定任务卡的更正", () => {
  type Access = { canRequest: boolean; canApply: boolean; closedReason: string | null };
  const requester: Access = { canRequest: true, canApply: false, closedReason: null };
  const decider: Access = { canRequest: false, canApply: true, closedReason: null };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fixes = () => ui.controls!.corrections!;
  const item = { id: "fix-1", missionId: "mission", field: "outcome", status: "pending", stale: false } as Correction;
  function confirmed(access: Access, round: Partial<typeof personalPayload.round> = {}) {
    const view = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, phase: "confirmed", approver: access.canApply, ...round }, card: { ...personalPayload.card, shown: "confirmed" }, correctionAccess: access } } as unknown as Card;
    ui.state[0] = view;
    ui.get.mockResolvedValue({ response: { ok: true }, data: { cards: [view] } });
    return render();
  }
  it.each([
    ["非拍板人申请", requester, "更正申请已提交，等刘明华处理；正文先不变。"],
    ["拍板人直接更正", decider, "已更正，改前改后都已留痕。"],
  ] as const)("%s：草稿预填当前文字，原因必填，body 带版本与字段，成功后关闭并重新加载任务卡", async (_who, access, notice) => {
    ui.post.mockResolvedValue({ response: { ok: true, status: 200 }, data: { correction: item } });
    confirmed(access); fixes().onOpen(mission, "outcome"); render();
    expect(fixes().draft).toMatchObject({ missionId: "mission", field: "outcome", sourceVersion: 1, text: "形成可核验结果", reason: "" });
    expect(fixes().draft!.clientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    fixes().onSubmit(); await settle();
    expect(ui.post).not.toHaveBeenCalled();
    fixes().onEdit({ text: "与团队完成共同核验" }); fixes().onEdit({ reason: " 客户要求调整口径 " }); render();
    const clientId = fixes().draft!.clientId;
    fixes().onSubmit(); await settle();
    const html = render();
    expect(ui.post).toHaveBeenCalledExactlyOnceWith("/api/mission-cards/{cardId}/corrections", { params: { path: { cardId: "card" } }, body: { clientId, missionId: "mission", field: "outcome", proposed: "与团队完成共同核验", reason: "客户要求调整口径", sourceVersion: 1 } });
    expect(fixes().draft).toBeNull();
    expect(ui.get).toHaveBeenCalledWith("/api/mission-cards/{cardId}", { params: { path: { cardId: "card" } } });
    expect(html).toContain(notice);
  });
  it("失败保留草稿并原样显示服务端原因与 fieldErrors；原样重试复用 clientId，改过再提交换新", async () => {
    confirmed(requester); fixes().onOpen(mission, "outcome"); render(); fixes().onEdit({ reason: "客户要求调整口径" }); render();
    ui.post.mockResolvedValueOnce({ response: { ok: false, status: 400 }, error: { code: "INVALID_INPUT", message: "输入校验失败", fieldErrors: { proposed: "must NOT have more than 4000 characters" } } });
    fixes().onSubmit(); await settle(); render();
    expect(fixes().draft).toMatchObject({ text: "形成可核验结果", reason: "客户要求调整口径" });
    expect(fixes().draftError).toBe("输入校验失败；proposed：must NOT have more than 4000 characters");
    const first = ui.post.mock.calls[0][1].body.clientId;
    ui.post.mockResolvedValueOnce({ response: { ok: false, status: 409 }, error: { code: "SOURCE_VERSION_CONFLICT", message: "页面版本已变化，请刷新后重新提交" } });
    fixes().onSubmit(); await settle(); render();
    expect(ui.post.mock.calls[1][1].body.clientId).toBe(first);
    expect(fixes().draftError).toBe("页面版本已变化，请刷新后重新提交");
    fixes().onEdit({ text: "改过的新结果" }); render();
    ui.post.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fixes().onSubmit(); await settle(); render();
    expect(ui.post.mock.calls[2][1].body.clientId).not.toBe(first);
    expect(fixes().draft).toMatchObject({ text: "改过的新结果", reason: "客户要求调整口径" });
    expect(fixes().draftError).toBe("暂时无法连接服务器，请稍后重试；输入已保留。");
    expect(ui.get).not.toHaveBeenCalled();
  });
  it("采纳只带结论；不采纳必须写一句原因；成功后刷新任务卡并让通知同步", async () => {
    ui.post.mockResolvedValue({ response: { ok: true, status: 200 }, data: { correction: item } });
    confirmed(decider);
    fixes().onDecide(item, "reject"); await settle();
    fixes().onRejecting({ id: "fix-1", note: "  " }); render();
    fixes().onDecide(item, "reject"); await settle();
    expect(ui.post).not.toHaveBeenCalled();
    fixes().onRejecting({ id: "fix-1", note: " 本月先不改 " }); render();
    fixes().onDecide(item, "reject"); await settle(); render();
    expect(ui.post).toHaveBeenLastCalledWith("/api/mission-cards/{cardId}/corrections/{correctionId}/decision", { params: { path: { cardId: "card", correctionId: "fix-1" } }, body: { decision: "reject", note: "本月先不改" } });
    expect(fixes().rejecting).toBeNull();
    expect(ui.get).toHaveBeenCalled();
    expect(ui.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "mission-round-changed" }));
    expect(ui.refresh).toHaveBeenCalled();
    fixes().onDecide(item, "apply"); await settle();
    expect(ui.post).toHaveBeenLastCalledWith("/api/mission-cards/{cardId}/corrections/{correctionId}/decision", { params: { path: { cardId: "card", correctionId: "fix-1" } }, body: { decision: "apply" } });
  });
  it("处理中重复点击只发一次；失败原因留在这条申请旁，不采纳的原因保留", async () => {
    let finish!: (value: unknown) => void;
    ui.post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    confirmed(decider); fixes().onRejecting({ id: "fix-1", note: "本月先不改" }); render();
    fixes().onDecide(item, "reject"); fixes().onDecide(item, "reject");
    expect(ui.post).toHaveBeenCalledOnce();
    finish({ response: { ok: false, status: 409 }, error: { code: "CORRECTION_DECIDED", message: "这条更正已经处理过" } });
    await settle(); render();
    expect(fixes().decisionError).toEqual({ correctionId: "fix-1", message: "这条更正已经处理过" });
    expect(fixes().rejecting).toEqual({ id: "fix-1", note: "本月先不改" });
    expect(fixes().busy).toBe(false);
    expect(ui.dispatch).not.toHaveBeenCalled();
  });
  it("深链 ?correction= 在入场焦点之后落到那条更正申请", () => {
    const frames: (() => void)[] = [], focused: string[] = [];
    const target = { focus: () => focused.push("correction"), scrollIntoView: vi.fn() };
    const getElementById = vi.fn().mockReturnValue(target);
    vi.stubGlobal("document", { getElementById });
    vi.stubGlobal("window", { location: { search: "?correction=fix-1" }, matchMedia: () => ({ matches: false }), requestAnimationFrame: (callback: () => void) => frames.push(callback), cancelAnimationFrame: vi.fn() });
    confirmed(decider); ui.effects[0]();
    frames.push(() => focused.push("close"));
    frames.splice(0).forEach((callback) => callback());
    frames.splice(0).forEach((callback) => callback());
    expect(focused).toEqual(["close", "correction"]);
    expect(getElementById).toHaveBeenCalledWith("correction-fix-1");
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });
  it("已确定后从第一条开始：第一条在别的卡就带 ?correction= 打开，在本卡就直接聚焦", () => {
    const row = personalPayload.round.cards[0];
    confirmed(decider, { cards: [{ ...row, pendingCorrections: 0 }, { ...row, cardId: "other-card", pendingCorrections: 2, firstPendingCorrectionId: "fix-9" }] });
    ui.roundProps!.onStartProcessing!();
    expect(ui.navigate).toHaveBeenCalledExactlyOnceWith("/me/mission-cards/other-card?correction=fix-9");
    const target = { focus: vi.fn(), scrollIntoView: vi.fn() };
    vi.stubGlobal("document", { getElementById: (id: string) => id === "correction-fix-1" ? target : null });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    confirmed(decider, { cards: [{ ...row, pendingCorrections: 1, firstPendingCorrectionId: "fix-1" }] });
    ui.roundProps!.onStartProcessing!();
    expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
    expect(ui.navigate).toHaveBeenCalledOnce();
  });
});
