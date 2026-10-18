import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { Card } from "@/lib/api/client";
import type { DocumentControls } from "./CardDocument";
import type { Correction } from "./CorrectionPanel";
import type { MissionDraftStatus } from "./MissionWorkflowActions";
import type { MissionRoundProgress } from "./MissionRoundProgress";
import type { MaterialMenu } from "@/components/shell/MaterialTabs";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({
  state: [] as unknown[], cursor: 0, controls: null as DocumentControls | null,
  payload: null as typeof personalPayload | null, ownerPlan: null as unknown, viewerId: "viewer", annotationPending: false,
  effects: [] as (() => void | (() => void))[],
  buttons: new Map<string, { onPress?: () => Promise<void> | void; isDisabled?: boolean }>(),
  post: vi.fn(), get: vi.fn(), register: vi.fn(), refresh: vi.fn(), navigate: vi.fn(), dispatch: vi.fn(), quote: vi.fn(),
  draftProps: null as ComponentProps<typeof MissionDraftStatus> | null,
  progress: null as ComponentProps<typeof MissionRoundProgress> | null,
  viewMenu: null as ComponentProps<typeof MaterialMenu> | null,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void | (() => void)) => { ui.effects.push(effect); }, useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.state)) ui.state[index] = initial;
    return [ui.state[index], (value: unknown) => { ui.state[index] = typeof value === "function" ? value(ui.state[index]) : value; }];
  } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: ui.refresh }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get, POST: ui.post } }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: ui.navigate, quote: ui.quote, viewerId: ui.viewerId }), useRegisterDetail: ui.register }));
vi.mock("@/lib/useSeenMarks", () => ({ useSeenMarks: () => ({ seen: null, mark: vi.fn() }) }));
vi.mock("./MissionAnnotations", () => ({ useMissionAnnotations: () => ({ notes: [], revisions: [], error: "", pending: ui.annotationPending, refresh: vi.fn(), save: vi.fn(), answer: vi.fn(), retry: vi.fn(), resolve: vi.fn() }) }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <div><header>{actions}</header>{children}</div> }));
vi.mock("@/components/shell/MaterialTabs", () => ({ InHeader: ({ children }: { children: ReactNode }) => <div data-header-tools>{children}</div>, MaterialMenu: (props: ComponentProps<typeof MaterialMenu>) => { ui.viewMenu = props; return <button data-material-menu>{props.tabs.find((tab) => tab.id === props.selected)?.label}</button>; } }));
vi.mock("./useRoundNow", () => ({ useRoundNow: (_at: string, now: string) => Date.parse(now) }));
vi.mock("ts-design/primitives", () => {
  const part = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Popover: Object.assign(part, { Content: part, Dialog: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div> }),
    Button: ({ children, onPress, isDisabled, "aria-label": label }: { children?: ReactNode; onPress?: () => Promise<void> | void; isDisabled?: boolean; "aria-label"?: string }) => {
      ui.buttons.set(String(children), { onPress, isDisabled }); if (label) ui.buttons.set(label, { onPress, isDisabled });
      return <button disabled={isDisabled} aria-label={label}>{children}</button>;
    } };
});
vi.mock("./MissionWorkflowActions", () => ({ MissionDraftStatus: (props: ComponentProps<typeof MissionDraftStatus>) => { ui.draftProps = props; return null; } }));
vi.mock("./MissionRoundProgress", () => ({ MissionRoundProgress: (props: ComponentProps<typeof MissionRoundProgress>) => { ui.progress = props; return <button data-progress>任务准备进度</button>; } }));
vi.mock("./CardDocument", async (original) => ({ ...await original<typeof import("./CardDocument")>(), CardDocument: ({ controls, ownerPlan, payload }: { controls: DocumentControls; ownerPlan?: unknown; payload: typeof personalPayload }) => { ui.controls = controls; ui.ownerPlan = ownerPlan; ui.payload = payload; return null; } }));
import { MissionCardScreen } from "./MissionCardScreen";

const card = { id: "personal-card", version: 1, kind: "personal-mission-card", payload: personalPayload, actions: [], conversation: { scope: "mission-card:card" } } as unknown as Card;
const mission = personalPayload.card.missions[0];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function render() { ui.cursor = 0; ui.buttons.clear(); ui.progress = null; return renderToStaticMarkup(<MissionCardScreen initialCard={card} entry="member" />); }
const group = () => ui.register.mock.calls.at(-1)![0].group;
const fixes = () => ui.controls!.corrections!;
function own(confirmed = false, canConfirm = true) {
  ui.viewerId = "owner";
  ui.state[0] = { ...card, version: 3, payload: { ...personalPayload,
    card: { ...personalPayload.card, ownerConfirmedAt: confirmed ? "2026-10-01T01:00:00Z" : null, missions: [mission, { ...mission, missionId: "mission-two", version: 7 }] },
    selfReview: { canConfirm: !confirmed && canConfirm, canCancel: confirmed, canEdit: !confirmed, blockedReason: canConfirm ? null : "请先处理 1 条未决修改，再确认我的任务。", pendingAnnotations: canConfirm ? 0 : 1 },
  } };
  return render();
}
function savedConfirmation() {
  const old = ui.state[0] as Card;
  return { ...old, payload: { ...(old.payload as typeof personalPayload), card: { ...(old.payload as typeof personalPayload).card, ownerConfirmedAt: "2026-10-01T01:00:00Z" }, selfReview: { canConfirm: false, canCancel: true, canEdit: false, blockedReason: null, pendingAnnotations: 0 } } };
}
beforeEach(() => {
  ui.state = []; ui.cursor = 0; ui.controls = null; ui.payload = null; ui.ownerPlan = null; ui.viewerId = "viewer"; ui.annotationPending = false; ui.effects = [];
  vi.clearAllMocks(); vi.stubGlobal("window", { dispatchEvent: ui.dispatch });
  ui.get.mockResolvedValue({ response: { ok: true }, data: { cards: [card] } });
});
afterEach(() => vi.unstubAllGlobals());

describe("任务卡页头与私人引用", () => {
  it("header复用会议材料下拉，只提供任务细节；没开放的执行拆分不出现", () => {
    const html = render();
    expect(html).toContain("data-header-tools"); expect(html).toContain("data-material-menu");
    expect(ui.viewMenu).toMatchObject({ selected: "details", label: "任务视图", switchLabel: "切换任务视图" });
    expect(ui.viewMenu!.tabs).toEqual([
      { id: "details", label: "任务细节", title: "任务细节" },
    ]);
    expect(html).not.toContain("执行拆分");
    expect(ui.viewMenu!.onAdd).toBeUndefined(); expect(ui.progress).toMatchObject({ compact: true, entry: "member" });
    expect(html).not.toContain("开始汇总"); expect(html).not.toContain("重新开放全部");
  });
  it("重试起草不带个人卡viewCardId，返回汇总卡后重新读取当前人的正文", async () => {
    const retry = { actionId: "retry-signed", actionType: "mission-round.draft", label: "重试起草" };
    const fresh = { ...card, version: 2, payload: { ...personalPayload, round: { ...personalPayload.round, phase: "drafting" } } };
    ui.post.mockResolvedValue({ response: { ok: true }, data: { cards: [{ id: "round-card", kind: "mission-round", payload: fresh.payload.round }] } });
    ui.get.mockResolvedValue({ response: { ok: true }, data: { cards: [fresh] } });
    render(); ui.draftProps!.onAction(retry); await vi.waitFor(() => expect(ui.get).toHaveBeenCalled()); await settle(); render();
    expect(ui.post).toHaveBeenCalledExactlyOnceWith("/api/mission-rounds/actions/execute", { body: { actionId: "retry-signed" } });
    expect(ui.payload!.card.ownerId).toBe("owner"); expect(ui.payload!.round.phase).toBe("drafting");
  });
  it("草稿操作回调不接受旧人工提前汇总与全体重开操作", async () => {
    render();
    for (const type of ["mission-round.close", "mission-round.reopen", "mission-round.confirm"]) ui.draftProps!.onAction({ actionId: "obsolete", actionType: type, label: "旧入口" });
    await settle(); expect(ui.post).not.toHaveBeenCalled();
  });
  it("本人未确认的其他卡禁用，确认后才可从页头打开", () => {
    const other = { ...personalPayload.round.cards[0], cardId: "other", ownerId: "other", ownerName: "孙铭泽", mine: false, contentVisible: false };
    ui.state[0] = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, cards: [personalPayload.round.cards[0], other] } } };
    expect(render()).toContain('aria-label="任务准备进度与操作"');
    const blocked = ui.buttons.get("本人确认后可查看孙铭泽的任务 · 待本人确认")!;
    expect(blocked.isDisabled).toBe(true); blocked.onPress!(); expect(ui.navigate).not.toHaveBeenCalled();
    ui.state[0] = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, cards: [personalPayload.round.cards[0], { ...other, contentVisible: true, ownerConfirmedAt: "2026-10-01T01:00:00Z" }] } } };
    render(); ui.buttons.get("打开孙铭泽的任务 · 本人已确认")!.onPress!();
    expect(ui.navigate).toHaveBeenCalledWith("/me/mission-cards/other");
  });
  it("任务卡只接本人私人Agent；引用独立携带来源，原文不会作为输入预填", () => {
    own(); expect(ui.ownerPlan).toBeUndefined(); expect(group()).toMatchObject({ reference: null, canDiscuss: false });
    expect(ui.controls!.annotations).toMatchObject({ notes: [], revisions: [] });
    ui.controls!.onQuote(mission, "outcome", "核验结果");
    expect(ui.quote).toHaveBeenCalledExactlyOnceWith("核验结果", { label: "完善方法闭环 · 战役结果", objectType: "mission-card", objectId: "card", missionId: "mission", field: "outcome", sourceRound: 1, sourceVersion: 1 });
    expect(ui.post).not.toHaveBeenCalled();
  });
  it("超过引用长度明确拒绝，旧公开修改建议回调不提交、不打开编辑器", () => {
    own(); ui.controls!.onQuote(mission, "outcome", "字".repeat(2001));
    expect(render()).toContain("超过 2000 字"); expect(ui.quote).not.toHaveBeenCalled();
    ui.controls!.onPropose(mission, "outcome"); render();
    expect(ui.controls!.proposalEditor).toBeUndefined(); expect(ui.post).not.toHaveBeenCalled();
  });
  it("引用旧选区保留选中时的来源窗口和正文版本", () => {
    own(); ui.controls!.onQuote({ ...mission, version: 2 }, "outcome", "核验结果", 4);
    expect(ui.quote).toHaveBeenCalledWith("核验结果", expect.objectContaining({ sourceRound: 4, sourceVersion: 2 }));
  });
});

describe("本人确认及稳定版本", () => {
  it("确认我的任务提交全部所见版本，成功后取消确认；不写入对话", async () => {
    own(); ui.post.mockResolvedValue({ response: { ok: true }, data: { cards: [savedConfirmation()] } });
    ui.buttons.get("确认我的任务")!.onPress!(); await vi.waitFor(() => expect(ui.post).toHaveBeenCalled()); await settle();
    expect(ui.post).toHaveBeenCalledExactlyOnceWith("/api/mission-cards/{cardId}/owner-confirmation", { params: { path: { cardId: "card" } }, body: { confirmed: true, round: 1, missionVersions: { mission: 1, "mission-two": 7 } } });
    expect(render()).toContain("取消确认"); expect(group()).not.toHaveProperty("agentNote"); expect(ui.quote).not.toHaveBeenCalled();
  });
  it("未决修改禁用确认并解释原因；取消只撤销本人确认", async () => {
    expect(own(false, false)).toContain("请先处理 1 条未决修改");
    expect(ui.buttons.get("确认我的任务")!.isDisabled).toBe(true); ui.buttons.get("确认我的任务")!.onPress!(); expect(ui.post).not.toHaveBeenCalled();
    own(true); ui.post.mockResolvedValue({ response: { ok: true }, data: { cards: [card] } });
    ui.buttons.get("取消本人确认")!.onPress!(); await vi.waitFor(() => expect(ui.post).toHaveBeenCalled());
    expect(ui.post.mock.calls[0][1].body).toEqual({ confirmed: false, round: 1, missionVersions: { mission: 1, "mission-two": 7 } });
  });
  it("批注提交未结束时无法同时确认", () => {
    ui.annotationPending = true; own();
    expect(ui.buttons.get("确认我的任务")!.isDisabled).toBe(true); ui.buttons.get("确认我的任务")!.onPress!();
    expect(ui.post).not.toHaveBeenCalled();
  });
  it("先发出的同版本刷新不能覆盖刚保存的本人确认", async () => {
    own(); const old = ui.state[0] as Card;
    let finish!: (value: unknown) => void; ui.get.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const refresh = group().onRefresh();
    ui.post.mockResolvedValue({ response: { ok: true }, data: { cards: [savedConfirmation()] } });
    ui.buttons.get("确认我的任务")!.onPress!(); await settle();
    finish({ response: { ok: true }, data: { cards: [old] } }); await refresh;
    expect(render()).toContain("取消确认");
  });
  it("版本冲突读取新正文并保留未确认状态，显示服务端原因", async () => {
    own(); ui.post.mockResolvedValue({ response: { ok: false, status: 409 }, error: { message: "任务内容刚刚变化，请重新阅读后确认" } });
    ui.get.mockResolvedValue({ response: { ok: true }, data: { cards: [{ ...(ui.state[0] as Card), version: 4 }] } });
    ui.buttons.get("确认我的任务")!.onPress!(); await vi.waitFor(() => expect(ui.get).toHaveBeenCalled()); await settle();
    const html = render(); expect(html).toContain("任务内容刚刚变化，请重新阅读后确认"); expect(html).toContain("确认我的任务"); expect(html).not.toContain("取消确认");
  });
  it("最终组合确认和退回原因保留只读记录，不显示本人确认按钮", () => {
    ui.viewerId = "owner";
    ui.state[0] = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, phase: "confirmed" }, selfReview: { ...personalPayload.selfReview, returnReason: "明确验收边界" }, confirmation: { by: "dri", byName: "刘明华", at: "2026-10-04T10:00:00Z", note: "依赖已核对" } } };
    const html = render(); expect(html).toContain("任务组合已确定"); expect(html).toContain("依赖已核对"); expect(html).toContain("明确验收边界"); expect(ui.buttons.has("确认我的任务")).toBe(false);
  });
});

describe("正式更正需退回本人准备", () => {
  type Access = typeof personalPayload.correctionAccess;
  const requester: Access = { canRequest: true, canApply: false, canReject: false, closedReason: null };
  const dri: Access = { canRequest: false, canApply: false, canReject: true, closedReason: null };
  const item = { id: "fix-1", missionId: "mission", field: "outcome", status: "pending", stale: false } as Correction;
  function confirmed(access: Access) {
    ui.viewerId = access.canRequest ? "owner" : "viewer";
    const view = { ...card, payload: { ...personalPayload, round: { ...personalPayload.round, phase: "confirmed", approver: access.canReject }, card: { ...personalPayload.card, shown: "confirmed" }, correctionAccess: access } } as Card;
    ui.state[0] = view; ui.get.mockResolvedValue({ response: { ok: true }, data: { cards: [view] } }); return render();
  }
  it("本人申请预填、原因必填、带来源版本；保存后待DRI退回，不直接改正文", async () => {
    ui.post.mockResolvedValue({ response: { ok: true }, data: { correction: item } });
    confirmed(requester); fixes().onOpen(mission, "outcome"); render();
    expect(fixes().draft).toMatchObject({ missionId: "mission", field: "outcome", sourceVersion: 1, text: "形成可核验结果", reason: "" });
    fixes().onSubmit(); await settle(); expect(ui.post).not.toHaveBeenCalled();
    fixes().onEdit({ text: "与团队完成共同核验", reason: " 客户要求调整口径 " }); render(); const clientId = fixes().draft!.clientId;
    fixes().onSubmit(); await settle(); const html = render();
    expect(ui.post).toHaveBeenCalledExactlyOnceWith("/api/mission-cards/{cardId}/corrections", { params: { path: { cardId: "card" } }, body: { clientId, missionId: "mission", field: "outcome", proposed: "与团队完成共同核验", reason: "客户要求调整口径", sourceVersion: 1 } });
    expect(fixes().draft).toBeNull(); expect(html).toContain("需由刘明华退回本人准备后修改"); expect(ui.payload!.card.missions[0].outcome).toBe(mission.outcome);
  });
  it("DRI不能打开他人的更正编辑器或直接采纳更正", async () => {
    confirmed(dri); fixes().onOpen(mission, "outcome"); render(); expect(fixes().draft).toBeNull();
    fixes().onDecide(item, "apply"); await settle(); expect(ui.post).not.toHaveBeenCalled();
  });
  it("申请失败保留输入和fieldErrors；重试复用clientId、编辑换新", async () => {
    confirmed(requester); fixes().onOpen(mission, "outcome"); render(); fixes().onEdit({ reason: "客户要求调整口径" }); render();
    ui.post.mockResolvedValueOnce({ response: { ok: false }, error: { message: "输入校验失败", fieldErrors: { proposed: "内容过长" } } });
    fixes().onSubmit(); await settle(); render();
    expect(fixes().draftError).toBe("输入校验失败；proposed：内容过长"); expect(fixes().draft!.reason).toBe("客户要求调整口径");
    const first = ui.post.mock.calls[0][1].body.clientId;
    ui.post.mockResolvedValueOnce({ response: { ok: false }, error: { message: "版本变化" } }); fixes().onSubmit(); await settle(); render();
    expect(ui.post.mock.calls[1][1].body.clientId).toBe(first);
    fixes().onEdit({ text: "改过的新结果" }); render(); ui.post.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fixes().onSubmit(); await settle(); render();
    expect(ui.post.mock.calls[2][1].body.clientId).not.toBe(first); expect(fixes().draft!.text).toBe("改过的新结果"); expect(fixes().draftError).toContain("输入已保留");
  });
  it("DRI不采纳必须写原因；成功刷新正文与通知", async () => {
    confirmed(dri); ui.post.mockResolvedValue({ response: { ok: true }, data: { correction: item } });
    fixes().onRejecting({ id: item.id, note: "  " }); render(); fixes().onDecide(item, "reject"); await settle(); expect(ui.post).not.toHaveBeenCalled();
    fixes().onRejecting({ id: item.id, note: " 本月先不改 " }); render(); fixes().onDecide(item, "reject"); await settle(); render();
    expect(ui.post).toHaveBeenCalledExactlyOnceWith("/api/mission-cards/{cardId}/corrections/{correctionId}/decision", { params: { path: { cardId: "card", correctionId: item.id } }, body: { decision: "reject", note: "本月先不改" } });
    expect(fixes().rejecting).toBeNull(); expect(ui.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "mission-round-changed" })); expect(ui.refresh).toHaveBeenCalled();
  });
  it("重复处理只发一次；失败保留不采纳原因", async () => {
    let finish!: (value: unknown) => void; ui.post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    confirmed(dri); fixes().onRejecting({ id: item.id, note: "本月先不改" }); render();
    fixes().onDecide(item, "reject"); fixes().onDecide(item, "reject"); expect(ui.post).toHaveBeenCalledOnce();
    finish({ response: { ok: false }, error: { message: "这条更正已经处理过" } }); await settle(); render();
    expect(fixes().decisionError).toEqual({ correctionId: item.id, message: "这条更正已经处理过" }); expect(fixes().rejecting).toEqual({ id: item.id, note: "本月先不改" }); expect(fixes().busy).toBe(false);
  });
  it("更正深链在入场关闭按钮定位后聚焦原申请", () => {
    const frames: (() => void)[] = [], focused: string[] = [];
    const target = { focus: () => focused.push("correction"), scrollIntoView: vi.fn() };
    const getElementById = vi.fn().mockReturnValue(target); vi.stubGlobal("document", { getElementById });
    vi.stubGlobal("window", { location: { search: "?correction=fix-1" }, matchMedia: () => ({ matches: false }), requestAnimationFrame: (callback: () => void) => frames.push(callback), cancelAnimationFrame: vi.fn() });
    confirmed(dri); ui.effects[0](); frames.push(() => focused.push("close"));
    frames.splice(0).forEach((callback) => callback()); frames.splice(0).forEach((callback) => callback());
    expect(focused).toEqual(["close", "correction"]); expect(getElementById).toHaveBeenCalledWith("correction-fix-1"); expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });
});
