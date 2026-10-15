import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/* 把组件当函数调用、点里面的按钮：hooks 用一个按调用顺序存值的小仓库代替（同 materialArea.behavior.test）。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, refs: [] as { current: unknown }[], refIndex: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    return (hooks.refs[hooks.refIndex++] ??= { current: initial });
  },
}));
const api = vi.hoisted(() => ({ post: vi.fn(), ask: vi.fn(async () => true) }));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useEffect: () => undefined, useCallback: (fn: unknown) => fn, useRef: hooks.useRef, useId: () => "block" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { POST: api.post } }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: api.ask, dialog: null }) }));

import type { Card } from "@/lib/api/client";
import { IssueDecisionBlock, type IssueBlockProps } from "./IssueDecisionBlock";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (node: Node): string => {
  const children = node.props?.children;
  return (Array.isArray(children) ? children : [children]).map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? text(child as Node) : "")).join("");
};
const buttons = (tree: unknown, label: string) => nodes(tree).filter((node) => node.type === "button" && text(node).includes(label));
const form = (tree: unknown) => nodes(tree).find((node) => node.props && "draft" in node.props && "onSubmit" in node.props);

const ISSUE = "22222222-2222-4222-8222-222222222222";
const doc = {
  summary: "清单前置能减少交付争议。",
  options: [{ id: "A", label: "先确定验收清单再签约", consequences: ["签约推迟约两周"] }, { id: "B", label: "先签约，交付时逐单协商", consequences: ["交付争议继续"] }],
  evidence: [], unknowns: [], sources: [],
};
function issueCard(payload: Record<string, unknown>, actions: Card["actions"], version = 3): Card {
  return {
    schemaVersion: 1, id: `issue:${ISSUE}`, version, kind: "issue", objectRef: { type: "issue", id: ISSUE, version }, title: "是否把验收清单前置到签约前",
    payload: { origin: "dri", originRef: null, status: "pending", location: { level: "company", relatedBattlefieldIds: [] }, urgency: { level: "red" },
      research: { status: "ready", doc }, receipts: [], dismissedAt: null, dismissReason: null, ...payload },
    actions,
  } as unknown as Card;
}
const decideAction = { actionId: "act-decide", actionType: "issue.decide", label: "直接决定" };
const pendingCard = issueCard({}, [decideAction]);
const decidedCard = issueCard({
  status: "decided",
  receipts: [{ id: "rc-1", actionType: "issue.decide", effectRef: `issue:${ISSUE}:decision:rc-1`, decisionText: "按「先签约，交付时逐单协商」执行", optionId: "B",
    researchStatusAtDecision: "ready", override: false, createdAt: "2026-10-09T06:32:00.000Z", revokedAt: null, revokeReason: null }],
}, [{ actionId: "act-revoke", actionType: "issue.revoke_receipt", label: "撤回决定", itemId: "rc-1" }], 4);

const onCard = vi.fn();
const props = (card: Card): IssueBlockProps => ({
  issueId: ISSUE, index: 1, total: 1, card, history: { status: "ready", data: null, error: null }, entries: [], summary: null,
  outcomeItems: [], renderOutcomeItem: () => null, focus: "decision", decisionActions: card.actions, scopeLabel: "公司战略", currentMeetingId: "m-1",
  outlineKey: `issue:${ISSUE}`, onCard, onOpenIssue: () => undefined,
});
const render = (card: Card) => {
  hooks.index = 0;
  hooks.refIndex = 0;
  return IssueDecisionBlock(props(card));
};
const markup = (card: Card) => {
  hooks.index = 0;
  hooks.refIndex = 0;
  return renderToStaticMarkup(<IssueDecisionBlock {...props(card)} />);
};

beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  vi.clearAllMocks();
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

describe("议题块里表达决定（feedback 15）：只走原生 issue.decide，回执以服务端为准", () => {
  it("按第二个选项决定：带上预研选项 id 和可改的决定文字，提交原生 Action；保存中不显示已决定", async () => {
    let tree = render(pendingCard);
    const choose = buttons(tree, "按此决定");
    expect(choose).toHaveLength(2);
    (choose[1].props!.onClick as () => void)();
    tree = render(pendingCard);
    const draft = form(tree)!.props!.draft as { optionId: string; text: string };
    expect(draft).toMatchObject({ optionId: "B", text: "按「先签约，交付时逐单协商」执行" });
    // CEO 把文字改一改再确认。
    (form(tree)!.props!.onChange as (value: unknown) => void)({ ...draft, text: "按「先签约，交付时逐单协商」执行，两周后复盘" });
    tree = render(pendingCard);

    let resolve: (value: unknown) => void = () => undefined;
    api.post.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    (form(tree)!.props!.onSubmit as () => void)();
    expect(api.post).toHaveBeenCalledWith("/api/actions/execute", {
      body: { actionId: "act-decide", input: { decisionText: "按「先签约，交付时逐单协商」执行，两周后复盘", optionId: "B" } },
    });
    // 保存中：按钮写「保存中…」，页面上没有任何「已决定」或回执。
    const saving = markup(pendingCard);
    expect(saving).toContain("保存中…");
    expect(saving).not.toContain("已写入决定回执");
    expect(saving).not.toContain("你已决定");

    resolve({ data: { cards: [decidedCard] }, error: undefined, response: { status: 200 } });
    await vi.waitFor(() => expect(onCard).toHaveBeenCalledWith(decidedCard));
    // 父页面没有换 Card 之前，本地不会自己显示「已决定」。
    expect(markup(pendingCard)).not.toContain("已写入决定回执");
    // 换成服务端返回的议题 Card：回执、选项、撤回入口都来自它。
    const decided = markup(decidedCard);
    expect(decided).toContain("你已决定：按「先签约，交付时逐单协商」执行");
    expect(decided).toContain("已写入决定回执");
    expect(decided).toContain("选项「先签约，交付时逐单协商」");
    expect(decided).toContain("撤回这个决定");
    expect(decided).not.toContain(">按此决定<");
    // 写入成功后通知历史重读。
    const events = (window.dispatchEvent as unknown as { mock: { calls: [Event][] } }).mock.calls.map(([event]) => event.type);
    expect(events).toEqual(expect.arrayContaining(["decision-history-changed"]));
  });

  it("保存失败：显示原因和重试，不显示已决定；重试提交同一 Action 和同一内容（服务端按指纹去重，不会写两条）", async () => {
    let tree = render(pendingCard);
    (buttons(tree, "按此决定")[0].props!.onClick as () => void)();
    tree = render(pendingCard);
    api.post.mockResolvedValueOnce({ data: undefined, error: { code: "INTERNAL", message: "网络中断" }, response: { status: 500 } });
    (form(tree)!.props!.onSubmit as () => void)();
    await vi.waitFor(() => expect(markup(pendingCard)).toContain("没有保存成功：网络中断"));
    const failed = markup(pendingCard);
    expect(failed).toContain("重试");
    expect(failed).not.toContain("已写入决定回执");
    expect(onCard).not.toHaveBeenCalled();
    tree = render(pendingCard);
    const feedback = nodes(tree).find((node) => node.props && "onRetry" in node.props && "state" in node.props);
    expect((feedback!.props!.state as { status: string }).status).toBe("error");
    api.post.mockResolvedValueOnce({ data: { cards: [decidedCard] }, error: undefined, response: { status: 200 } });
    (feedback!.props!.onRetry as () => void)();
    await vi.waitFor(() => expect(onCard).toHaveBeenCalledWith(decidedCard));
    expect(api.post.mock.calls[0][1]).toEqual(api.post.mock.calls[1][1]);
  });

  it("预研未完成：只能直接填写决定，必须勾选二次确认，提交 issue.decide_override 且不带选项 id", async () => {
    const card = issueCard({ research: { status: "failed", error: { code: "x", message: "上游超时", at: "2026-10-01" } } },
      [{ actionId: "act-override", actionType: "issue.decide_override", label: "预研未完成时直接决定" }]);
    let tree = render(card);
    expect(buttons(tree, "按此决定")).toHaveLength(0);
    (buttons(tree, "直接填写决定")[0].props!.onClick as () => void)();
    tree = render(card);
    const draft = form(tree)!.props!.draft as object;
    (form(tree)!.props!.onChange as (value: unknown) => void)({ ...draft, text: "先按分级清单试行一个月" });
    tree = render(card);
    (form(tree)!.props!.onSubmit as () => void)();
    tree = render(card);
    expect(form(tree)!.props!.error).toBe("预研尚未完成：请先勾选确认在预研未完成时作出决定");
    expect(api.post).not.toHaveBeenCalled();
    (form(tree)!.props!.onChange as (value: unknown) => void)({ ...(form(tree)!.props!.draft as object), overrideConfirmed: true });
    tree = render(card);
    api.post.mockResolvedValueOnce({ data: { cards: [decidedCard] }, error: undefined, response: { status: 200 } });
    (form(tree)!.props!.onSubmit as () => void)();
    expect(api.post).toHaveBeenCalledWith("/api/actions/execute", {
      body: { actionId: "act-override", input: { decisionText: "先按分级清单试行一个月", confirmOverride: true } },
    });
  });

  it("撤回这个决定：先确认，再走原生 issue.revoke_receipt", async () => {
    const tree = render(decidedCard);
    api.post.mockResolvedValueOnce({ data: { cards: [pendingCard] }, error: undefined, response: { status: 200 } });
    await (buttons(tree, "撤回这个决定")[0].props!.onClick as () => Promise<void>)();
    expect(api.ask).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/actions/execute", { body: { actionId: "act-revoke", input: {} } }));
  });

  it("没有决定权限（正式版或成员）时不给任何决定按钮", () => {
    hooks.index = 0;
    hooks.refIndex = 0;
    const html = renderToStaticMarkup(<IssueDecisionBlock {...props(pendingCard)} decisionActions={[]} />);
    expect(html).not.toContain("按此决定");
    expect(html).not.toContain("自拟决定内容");
    expect(html).toContain("决定由会后结论确认生效");
  });
});

describe("会议页议题块的来源标注", () => {
  it("AI 候选议题：标题旁不标来源；来自雷达的议题标「雷达」小标签；真实议题不标", () => {
    expect(markup(issueCard({ nature: "ai_suggested" }, []))).toMatch(/<h2 id="block">是否把验收清单前置到签约前<\/h2>/);
    expect(markup(issueCard({ nature: "ai_suggested", origin: "radar" }, []))).toMatch(/<h2 id="block">是否把验收清单前置到签约前<span[^>]*data-origin-tag="radar"[^>]*>/);
    expect(markup(pendingCard)).not.toContain("AI 建议");
  });
});

describe("会议页议题块的预研判断", () => {
  it("预审还没有核心判断时，预研判断按要点列表显示，不露出「- 」和「**」记号", () => {
    const card = issueCard({ research: { status: "ready", doc: { ...doc, summary: "- **建议采用单客户连续付费方案**：同一外部客户连续两个周期付费。\n- **证据必须能够相互核对**：合同、流水、到账对应同一客户。" } } }, [decideAction]);
    const html = markup(card);
    expect(html).toContain("<strong>预研判断</strong>");
    expect(html).toMatch(/<ul><li><strong>建议采用单客户连续付费方案<\/strong>：同一外部客户连续两个周期付费。<\/li><li><strong>证据必须能够相互核对<\/strong>/);
    expect(html).not.toContain("**");
    expect(html).not.toMatch(/>- /);
  });
});
