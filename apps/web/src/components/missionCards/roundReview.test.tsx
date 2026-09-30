import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({ buttons: new Map<string, { onPress?: () => void; isDisabled?: boolean }>() }));
vi.mock("react", async (importOriginal) => ({ ...await importOriginal<typeof import("react")>(), useEffect: () => {}, useState: () => [true, vi.fn()] }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, isDisabled, isIconOnly: _icon, ...props }: { children?: ReactNode; onPress?: () => void; isDisabled?: boolean; isIconOnly?: boolean }) => {
  ui.buttons.set(String(children), { onPress, isDisabled }); return <button disabled={isDisabled} {...props}>{children}</button>;
} }));
import { CardDocument } from "./CardDocument";
import { RoundLine } from "./RoundLine";

const action = { actionId: "decide-token", actionType: "mission-round.decide", label: "处理意见" };
const feedback = { id: "feedback-1", seq: 1, missionId: "mission", field: "outcome", kind: "suggestion", authorId: "owner", authorName: "白田田", body: "让结果可核验", quote: null, proposed: "与团队完成共同核验", original: "形成可核验结果", sourceVersion: 1, basis: "draft", late: false, round: 1, createdAt: "2026-10-02T02:00:00.000Z", verdict: { text: "待拍板人处理", tone: "wait" }, decision: null, actions: [action], acceptBlockedReason: null } as unknown as TPersonalMissionCardPayload["feedback"][number];
const payload = { ...personalPayload, round: { ...personalPayload.round, phase: "reviewing", counts: { cards: 5, feedback: 3, pending: 1, conflicts: 1, dependencies: 7, late: 1, corrections: 0 }, cards: [{ ...personalPayload.round.cards[0], pending: 1, firstPendingFeedbackId: "feedback-1" }] }, feedback: [feedback] } as TPersonalMissionCardPayload;
const controls = { onQuote: vi.fn(), onPropose: vi.fn(), onSelect: vi.fn(), onDecide: vi.fn(), pending: false };
const props = { payload, actions: [{ actionId: "reopen", actionType: "mission-round.reopen", label: "重新开启" }], viewerId: "ceo", pending: false, onAction: vi.fn(), onSelectCard: vi.fn(), onViewGoals: vi.fn(), onStartProcessing: vi.fn(), note: "", onNoteChange: vi.fn() };
beforeEach(() => { ui.buttons.clear(); vi.clearAllMocks(); });

describe("集中 Review 的可执行边界", () => {
  it("原文建议对照和卡字段位置清楚，单个签名 token 携带明确结论", () => {
    const html = renderToStaticMarkup(<CardDocument payload={payload} controls={controls} />);
    expect(html).toContain("白田田的卡 · 完善方法闭环 · 战役结果");
    expect(html).toContain("形成可核验结果");
    expect(html).toContain("与团队完成共同核验");
    expect(html).toContain('id="feedback-feedback-1"');
    ui.buttons.get("采纳修改")!.onPress!();
    expect(controls.onDecide).toHaveBeenCalledWith(feedback, "accept");
    ui.buttons.get("不采纳")!.onPress!();
    expect(controls.onDecide).toHaveBeenLastCalledWith(feedback, "decline");
  });
  it("同字段冲突原因由服务端给出，禁用采纳仍允许不采纳", () => {
    const blocked = { ...feedback, acceptBlockedReason: "同一字段已采纳另一条" };
    const html = renderToStaticMarkup(<CardDocument payload={{ ...payload, feedback: [blocked] }} controls={controls} />);
    expect(html).toContain("同一字段已采纳另一条");
    expect(ui.buttons.get("采纳修改")?.isDisabled).toBe(true);
    expect(ui.buttons.get("不采纳")?.isDisabled).toBe(false);
  });
  it("评论和引用只纳入核对，已处理项仍可改判", () => {
    renderToStaticMarkup(<CardDocument payload={{ ...payload, feedback: [{ ...feedback, kind: "comment", decision: "decline" }] }} controls={controls} />);
    expect(ui.buttons.has("已纳入核对")).toBe(true);
    expect(ui.buttons.get("不采纳")?.isDisabled).toBe(true);
    expect(ui.buttons.get("已纳入核对")?.isDisabled).toBe(false);
  });
  it.each([false, true])("参与者与确认后的卡不出现处理控件：confirmed=%s", (confirmed) => {
    const html = renderToStaticMarkup(<CardDocument payload={{ ...payload, round: { ...payload.round, approver: confirmed, phase: confirmed ? "confirmed" : "reviewing" } }} controls={controls} />);
    expect(html).toContain("待拍板人处理");
    expect(html).not.toContain(">采纳修改</button>");
    expect(html).not.toContain(">不采纳</button>");
  });
  it("服务端全战场三步数字直接展示，待处理主动作启动跨卡导航", () => {
    const html = renderToStaticMarkup(<RoundLine {...props} />);
    expect(html).toContain('aria-label="集中 Review 的三步结果"');
    expect(html).toContain("收下 5 张卡、3 条公开意见（私聊不收）");
    expect(html).toContain("同一字段 1 处冲突");
    expect(html).toContain("按依赖原文列出 7 条");
    expect(html).toContain("规则汇总 · 未做语义判断");
    expect(html).toContain("截止后留言 1 条 · 不在这一轮");
    ui.buttons.get("从第一条开始")!.onPress!();
    expect(props.onStartProcessing).toHaveBeenCalledOnce();
    expect(html).not.toContain("textarea");
  });
  it("全部处理后才出现核对，空白禁用；提交有长度限制的真实结论", () => {
    const confirm = { actionId: "confirm-token", actionType: "mission-round.confirm", label: "确认本月 Mission Card" };
    const reviewed = { ...payload, round: { ...payload.round, counts: { ...payload.round.counts, pending: 0 } } };
    const empty = renderToStaticMarkup(<RoundLine {...props} payload={reviewed} actions={[confirm]} note={"  \n "} />);
    expect(empty).toContain("跨人员依赖、冲突与协作的核对结论");
    expect(empty).toContain('maxLength="2000"');
    expect(ui.buttons.get("确认本月 Mission Card")?.isDisabled).toBe(true);
    renderToStaticMarkup(<RoundLine {...props} payload={reviewed} actions={[confirm]} note="  双方已核对交付边界。  " />);
    ui.buttons.get("确认本月 Mission Card")!.onPress!();
    expect(props.onAction).toHaveBeenCalledWith(confirm, { note: "双方已核对交付边界。" });
  });
  it("确认记录向所有人展示，不保留核对表单与重开动作", () => {
    const html = renderToStaticMarkup(<RoundLine {...props} payload={{ ...payload, round: { ...payload.round, phase: "confirmed" }, confirmation: { by: "ceo", byName: "刘明华", at: "2026-10-03T01:00:00Z", note: "依赖和交接已逐人核对。" } }} />);
    expect(html).toContain("依赖和交接已逐人核对。");
    expect(html).toContain("确认记录");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain(">重新开放讨论</button>");
  });
});
