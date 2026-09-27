import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
const roundUi = vi.hoisted(() => ({ effects: [] as (() => void)[], expanded: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void) => { roundUi.effects.push(effect); }, useState: (value: unknown) => [value, roundUi.expanded] };
});
vi.mock("ts-design/primitives", () => ({ Button: ({ children, isDisabled, onPress: _onPress, isIconOnly: _icon, ...props }: { children?: ReactNode; isDisabled?: boolean; onPress?: unknown; isIconOnly?: boolean }) => <button disabled={isDisabled} {...props}>{children}</button> }));
import { CardDocument, missionFieldText, selectedFieldQuote } from "./CardDocument";
import { RoundClock, roundClockText } from "./RoundClock";
import { RoundLine } from "./RoundLine";

import { personalPayload } from "./personalMissionFixture";
const controls = { onQuote: vi.fn(), onPropose: vi.fn(), onSelect: vi.fn() };
beforeEach(() => { roundUi.effects = []; roundUi.expanded.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

describe("个人卡正文的阶段与追溯", () => {
  it.each(["draft", "open", "closed", "reviewing", "confirmed"] as const)("%s 阶段只显示允许的字段动作，责任人始终不可建议", (phase) => {
    const html = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, round: { ...personalPayload.round, phase } }} controls={controls} />);
    expect((html.match(/>建议修改</g) ?? []).length).toBe(phase === "open" ? 12 : 0);
    expect((html.match(/>引用并评论</g) ?? []).length).toBe(phase === "open" ? 12 : 0);
    expect((html.match(/>引用到群组</g) ?? []).length).toBe(phase === "closed" || phase === "reviewing" ? 12 : 0);
    expect(html).toContain("唯一责任人");
    expect(html).toContain("占位 · 沿用 9 月个人卡");
    expect(html).toContain("飞书 r9");
    expect(html).not.toContain("下载原件");
    expect(html).not.toContain("未报告");
  });
  it("列表字段按原文行连接，缺字段诚实标注未提供", () => {
    expect(missionFieldText(personalPayload.card.missions[0], "successEvidence")).toBe("证据一\n证据二");
    const mission = { ...personalPayload.card.missions[0], resources: "" };
    expect(renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, card: { ...personalPayload.card, missions: [mission] } }} controls={controls} />)).toContain("未提供");
  });
  it("建议永远展示保存时的原文和版本，整卡意见保留作者与服务端判定", () => {
    const feedback = { id: "feedback", seq: 1, missionId: "mission", field: "outcome", kind: "suggestion", authorId: "owner", authorName: "白田田", body: "建议修改「预期结果」", quote: null, proposed: "新的结果", original: "提交那一刻的原文", sourceVersion: 1, basis: "draft", late: false, round: 1, createdAt: "2026-10-01T02:00:00.000Z", verdict: { text: "待拍板人处理", tone: "wait" }, decision: null, acceptBlockedReason: null, actions: [] } as TPersonalMissionCardPayload["feedback"][number];
    const html = renderToStaticMarkup(<CardDocument payload={{ ...personalPayload, feedback: [feedback, { ...feedback, id: "loose", kind: "comment", missionId: null, field: null, proposed: null, original: null }] }} controls={controls} />);
    expect(html).toContain("提交那一刻的原文");
    expect(html).toContain("草稿 v1");
    expect(html).toContain("待拍板人处理");
    expect(html).toContain("整张卡上的意见");
  });
  it("划词必须完整位于同一字段，不带走跨字段选择", () => {
    const inside = {} as Node, outside = {} as Node;
    const node = { contains: (candidate: Node) => candidate === inside } as HTMLElement;
    expect(selectedFieldQuote(node, { anchorNode: inside, focusNode: inside, toString: () => "  一句引用  " })).toBe("一句引用");
    expect(selectedFieldQuote(node, { anchorNode: inside, focusNode: outside, toString: () => "跨字段" })).toBeNull();
  });
});

describe("本轮状态与倒计时", () => {
  it.each([
    ["draft", "个人卡草稿已就绪，可以统一开放讨论", 0],
    ["reviewing", "3 条待你处理", 3],
    ["reviewing", "意见已全部处理，待你确认", 0],
    ["closed", "已截止 · 汇总中", 0],
  ] as const)("%s 的本轮状态与通知使用同一句", (phase, text, pending) => {
    const round = { ...personalPayload.round, phase, todo: phase === "closed" ? null : text, counts: { ...personalPayload.round.counts, pending } };
    const html = renderToStaticMarkup(<RoundLine payload={{ ...personalPayload, round }} actions={[]} viewerId="ceo" pending={false} onAction={vi.fn()} onSelectCard={vi.fn()} onViewGoals={vi.fn()} />);
    expect(html).toContain(text);
  });
  it("首次打开自动展开五步，同一个人的同一轮只自动展开一次", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) });
    const props = { payload: personalPayload, actions: [], viewerId: "ceo", pending: false, onAction: vi.fn(), onSelectCard: vi.fn(), onViewGoals: vi.fn() };
    renderToStaticMarkup(<RoundLine {...props} />); roundUi.effects.at(-1)!();
    renderToStaticMarkup(<RoundLine {...props} />); roundUi.effects.at(-1)!();
    expect(roundUi.expanded).toHaveBeenCalledExactlyOnceWith(true);
    renderToStaticMarkup(<RoundLine {...props} viewerId="member" />); roundUi.effects.at(-1)!();
    expect(roundUi.expanded).toHaveBeenCalledTimes(2);
  });
  it.each([[48 * 60, "48 小时 0 分"], [31 * 60 + 24, "31 小时 24 分"], [42, "42 分"], [0.5, "不到 1 分"], [0, "已截止"], [-1, "已截止"]])("剩余 %s 分钟写作 %s", (minutes, text) => {
    const now = Date.parse(personalPayload.round.closesAt!) - Number(minutes) * 60_000;
    expect(roundClockText(personalPayload.round, now)).toBe(text);
  });
  it("未开放不显示数字，已确定不再显示倒计时；重开标明轮次", () => {
    expect(roundClockText({ ...personalPayload.round, phase: "draft" }, 0)).toBe("本轮未开放");
    expect(roundClockText({ ...personalPayload.round, phase: "confirmed" }, 0)).toBe("已确定");
    const html = renderToStaticMarkup(<RoundClock round={{ ...personalPayload.round, round: 2 }} now={Date.parse(personalPayload.round.serverNow)} />);
    expect(html).toContain("第 2 轮");
    expect(html).toContain("截止于");
  });
  it.each(["draft", "open", "closed", "reviewing", "confirmed"] as const)("%s 阶段开放按钮只给草稿拍板人", (phase) => {
    const props = { payload: { ...personalPayload, round: { ...personalPayload.round, phase } }, actions: [{ actionId: "open", actionType: "mission-round.open", label: "统一开放 48 小时讨论" }], viewerId: "ceo", pending: false, onAction: vi.fn(), onSelectCard: vi.fn(), onViewGoals: vi.fn() };
    const html = renderToStaticMarkup(<RoundLine {...props} />);
    expect(html.includes(">统一开放 48 小时讨论</button>")).toBe(phase === "draft");
    expect(renderToStaticMarkup(<RoundLine {...props} payload={{ ...props.payload, round: { ...props.payload.round, approver: false } }} />)).not.toContain(">统一开放 48 小时讨论</button>");
  });
});
