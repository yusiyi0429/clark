import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { TMissionRoundSummary } from "@warmap/contracts";
import type { Card } from "@/lib/api/client";

type Control = { disabled?: boolean; onClick?: () => void; onPress?: () => void; onChange?: (event: { target: { value?: string; checked?: boolean } }) => void; value?: string; checked?: boolean };
const h = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  callbacks: [] as { callback: unknown; deps: readonly unknown[] }[], stateIndex: 0, refIndex: 0, effectIndex: 0, callbackIndex: 0,
  queued: [] as (() => unknown)[], dirty: false, buttons: new Map<string, Control>(), textareas: new Map<string, Control>(), checks: [] as Control[],
  popup: null as { isOpen: boolean; onOpenChange: (open: boolean) => void } | null, poll: null as (() => void) | null,
  get: vi.fn(), post: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.stateIndex++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? initial() : initial;
      return [h.states[index], (update: unknown) => {
        const next = typeof update === "function" ? update(h.states[index]) : update;
        if (!Object.is(next, h.states[index])) h.dirty = true;
        h.states[index] = next;
      }];
    },
    useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      const index = h.callbackIndex++, previous = h.callbacks[index];
      if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) h.callbacks[index] = { callback, deps };
      return h.callbacks[index].callback;
    },
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const index = h.effectIndex++, previous = h.dependencies[index];
      if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
        h.dependencies[index] = deps; h.queued.push(effect);
      }
    },
  };
});
vi.mock("ts-design", () => ({ TianshuPortalTheme: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("ts-design/primitives", () => {
  // Read the native controls from the actual element tree passed to the dialog, without replacing their handlers.
  const controls = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(controls); return; }
    if (!node || typeof node !== "object" || !("props" in node) || !("type" in node)) return;
    const props = node.props as Record<string, unknown>;
    if (node.type === "textarea") h.textareas.set(String(props["aria-label"] ?? props.id), props as Control);
    if (node.type === "input" && props.type === "checkbox") h.checks.push(props as Control);
    if (node.type === "button" && typeof props.children === "string") h.buttons.set(props.children, props as Control);
    controls(props.children);
  };
  return {
  Popover: Object.assign(({ children, ...props }: { children: ReactNode; isOpen: boolean; onOpenChange: (open: boolean) => void }) => {
    h.popup = props; return <>{children}</>;
  }, { Content: ({ children }: { children: ReactNode }) => h.popup?.isOpen ? <>{children}</> : null,
    Dialog: ({ children, ...props }: { children: ReactNode }) => { controls(children); return <section {...props}>{children}</section>; } }),
  Button: ({ children, onPress, isDisabled, variant: _variant, ...props }: { children: ReactNode; onPress?: () => void; isDisabled?: boolean; variant?: string; "aria-label"?: string }) => {
    const control = { onPress, disabled: isDisabled };
    h.buttons.set(String(children), control); if (props["aria-label"]) h.buttons.set(props["aria-label"], control);
    return <button {...props} disabled={isDisabled}>{children}</button>;
  },
}; });
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: h.get, POST: h.post } }));
vi.mock("./CardDocument", () => ({ fieldNames: { outcome: "战役结果" } }));

import { MissionRoundProgress } from "./MissionRoundProgress";
import { personalPayload } from "./personalMissionFixture";

const start = { actionId: "open-v3", actionType: "mission-round.open", label: "下发本人确认" };
const confirm = { actionId: "confirm-v3", actionType: "mission-round.confirm", label: "确认任务组合" };
const retry = { actionId: "retry-v3", actionType: "mission-round.review-retry", label: "重试 Co-Agent 核对" };
const confirmedAt = "2026-10-01T03:00:00.000Z";

function round(overrides: Partial<TMissionRoundSummary> = {}): TMissionRoundSummary {
  return { ...structuredClone(personalPayload.round), version: 3, phase: "draft", approver: true,
    counts: { ...personalPayload.round.counts, cards: 2, unreviewed: 1 },
    cards: [
      { ...personalPayload.round.cards[0], cardId: "card-sun", ownerId: "sun", ownerName: "孙铭泽", ownerConfirmedAt: null, contentVisible: false, mine: false },
      { ...personalPayload.round.cards[0], cardId: "card-wang", ownerId: "wang", ownerName: "王路遥", ownerConfirmedAt: confirmedAt, contentVisible: true, mine: false },
    ], coAgentReview: null, ...overrides };
}
function reviewing(overrides: Partial<TMissionRoundSummary> = {}) {
  const value = round({ phase: "reviewing", counts: { ...personalPayload.round.counts, cards: 2, unreviewed: 0 },
    coAgentReview: { status: "completed", summary: "核对了目标、任务组合和依赖", findings: [], error: null, completedAt: confirmedAt, retryAction: null }, ...overrides });
  return { ...value, cards: value.cards.map((card) => ({ ...card, ownerConfirmedAt: confirmedAt, contentVisible: true })) };
}
function reply(value: TMissionRoundSummary, actions: Card["actions"] = []) {
  return { response: { ok: true }, data: { cards: [{ kind: "mission-round", payload: value, actions }] } };
}
beforeEach(() => {
  h.states = []; h.refs = []; h.dependencies = []; h.callbacks = []; h.poll = null; vi.clearAllMocks();
  vi.stubGlobal("window", { setInterval: (callback: () => void) => { h.poll = callback; return 1; }, clearInterval: vi.fn(), dispatchEvent: h.dispatch });
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

function setup(value = round(), actions: Card["actions"] = [start], entry: "member" | "ceo" = "member") {
  h.get.mockResolvedValue(reply(value, actions)); h.post.mockResolvedValue(reply({ ...value, phase: "open" }));
  const props: ComponentProps<typeof MissionRoundProgress> = { round: value, entry, onNavigate: vi.fn(), onRefresh: vi.fn() };
  const render = () => {
    let html = "";
    for (let pass = 0; pass < 8; pass++) {
      h.stateIndex = 0; h.refIndex = 0; h.effectIndex = 0; h.callbackIndex = 0; h.dirty = false; h.queued = [];
      h.buttons.clear(); h.textareas.clear(); h.checks = [];
      html = renderToStaticMarkup(<MissionRoundProgress {...props} />); h.queued.forEach((effect) => effect());
      if (!h.dirty) return html;
    }
    throw new Error("Mission progress did not settle");
  };
  const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return render(); };
  const open = async () => { render(); h.popup!.onOpenChange(true); render(); return settle(); };
  const click = (label: string, force = false) => {
    const control = h.buttons.get(label);
    if (!control) throw new Error(`Button missing: ${label}`);
    if (control.disabled && !force) return false;
    (control.onPress ?? control.onClick)?.(); render(); return true;
  };
  const text = (key: string, value: string) => { h.textareas.get(key)!.onChange!({ target: { value } }); render(); };
  const select = (index: number, checked = true) => { h.checks[index].onChange!({ target: { checked } }); render(); };
  return { props, render, settle, open, click, text, select };
}

describe("战场 DRI 的任务准备进度与核对", () => {
  it("Escape 只关闭进度浮层，阻止外层工作区返回首页", async () => {
    const view = setup(); await view.open();
    const listener = vi.mocked(document.addEventListener).mock.calls.find(([name]) => name === "keydown")?.[1] as (event: KeyboardEvent) => void;
    const event = { key: "Escape", isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listener(event as unknown as KeyboardEvent); view.render();
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(h.popup?.isOpen).toBe(false); expect(view.props.onNavigate).not.toHaveBeenCalled();
  });
  it.each(["member", "ceo"] as const)("%s 只看未确认卡的进度，不能打开其私人正文；本人确认后卡可打开", async (entry) => {
    const { props, open, click } = setup(round(), [start], entry); const html = await open();
    const privateButton = h.buttons.get("孙铭泽 · 待本人确认，正文仅本人可见")!;
    expect(privateButton.disabled).toBe(true); expect(html).toContain("正文仅本人可见");
    privateButton.onPress!(); expect(props.onNavigate).not.toHaveBeenCalled();
    click("王路遥 · 本人已确认，查看任务");
    expect(props.onNavigate).toHaveBeenCalledExactlyOnceWith(`${entry === "member" ? "/me" : ""}/mission-cards/card-wang`);
  });
  it("下发时重新读取授权动作，发送最新签名token并刷新进度", async () => {
    const { props, open, click, settle } = setup(); await open();
    h.get.mockResolvedValue(reply(round({ version: 4 }), [{ ...start, actionId: "open-v4" }]));
    click("下发本人确认"); await settle();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("/api/mission-rounds/actions/execute", { body: { actionId: "open-v4" } });
    expect(props.onRefresh).toHaveBeenCalledOnce(); expect(h.dispatch).toHaveBeenCalledOnce();
  });
  it("读取失败显示原始问题并可重试，没有授权动作时不能下发", async () => {
    const { open, click, settle } = setup(); h.get.mockResolvedValueOnce({ response: { ok: false }, error: { message: "进度读取失败" } });
    expect(await open()).toContain("进度读取失败"); expect(h.post).not.toHaveBeenCalled();
    h.get.mockResolvedValue(reply(round(), [])); click("重新读取"); const html = await settle();
    expect(html).not.toContain("进度读取失败"); expect(h.buttons.has("下发本人确认")).toBe(false);
  });
  it("Co-Agent 核对失败保留报告错误，只用重新读取后授予的重试token", async () => {
    const failed = reviewing({ coAgentReview: { status: "failed", summary: "", findings: [], error: "报告未通过依据校验", completedAt: null, retryAction: retry } });
    const { open, click, settle } = setup(failed, [retry]); expect(await open()).toContain("报告未通过依据校验");
    h.get.mockResolvedValue(reply({ ...failed, coAgentReview: { ...failed.coAgentReview!, retryAction: { ...retry, actionId: "retry-new" } } }, [{ ...retry, actionId: "retry-new" }]));
    click("重试 Co-Agent 核对"); await settle();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("/api/mission-rounds/actions/execute", { body: { actionId: "retry-new" } });
  });
  it("退回必须选人并填写原因，仅选中的卡连同裁剪后的原因和版本提交", async () => {
    const current = reviewing(); const { props, open, click, text, select, settle } = setup(current, [confirm]); await open();
    click("退回相关任务"); expect(h.buttons.get("退回本人准备")!.disabled).toBe(true);
    select(1); expect(h.buttons.get("退回本人准备")!.disabled).toBe(true); text("退回原因", "  请明确这项依赖的交付时间  ");
    click("退回本人准备"); await settle();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("/api/mission-rounds/{roundId}/return-cards", { params: { path: { roundId: "round" } }, body: { cardIds: ["card-wang"], reason: "请明确这项依赖的交付时间", version: 3 } });
    expect(props.onRefresh).toHaveBeenCalledOnce(); expect(h.textareas.has("退回原因")).toBe(false);
  });
  it("退回失败刷新进度后仍显示错误，原因与选人保留以供重试", async () => {
    const current = reviewing(); const { props, open, click, text, select, settle } = setup(current, [confirm]); await open();
    click("退回相关任务"); select(0); text("退回原因", "需补齐验收证据");
    h.post.mockResolvedValueOnce({ response: { ok: false }, error: { message: "退回尚未保存" } });
    click("退回本人准备"); const html = await settle();
    expect(html).toContain("退回尚未保存"); expect(h.textareas.get("退回原因")!.value).toBe("需补齐验收证据");
    expect(h.checks[0].checked).toBe(true); expect(props.onRefresh).not.toHaveBeenCalled();
    click("重新读取"); await settle(); click("退回本人准备"); await settle(); expect(h.post).toHaveBeenCalledTimes(2);
  });
  it("退回准备期间版本变化保留输入且禁用提交，显式核对后才绑定新版本", async () => {
    const current = reviewing(); const { open, click, text, select, settle } = setup(current, [confirm]); await open();
    click("退回相关任务"); select(0); text("退回原因", "需补齐验收证据");
    h.get.mockResolvedValue(reply({ ...current, version: 4 }, [{ ...confirm, actionId: "confirm-v4" }])); h.poll!(); const html = await settle();
    expect(html).toContain("任务版本已变化"); expect(h.textareas.get("退回原因")!.value).toBe("需补齐验收证据");
    expect(h.checks[0].checked).toBe(true); expect(h.buttons.get("退回本人准备")!.disabled).toBe(true);
    click("退回本人准备", true); await settle(); expect(h.post).not.toHaveBeenCalled();
    click("已核对最新任务"); click("退回本人准备"); await settle();
    expect(h.post.mock.calls[0][1].body).toMatchObject({ cardIds: ["card-sun"], reason: "需补齐验收证据", version: 4 });
  });
  it("确认提交前最后一次读取发现版本变化时停止提交并保留结论", async () => {
    const current = reviewing(); const { props, open, click, text, settle } = setup(current, [confirm]); await open();
    text("mission-combination-round", "依赖与责任边界已核对");
    h.get.mockResolvedValue(reply({ ...current, version: 4 }, [{ ...confirm, actionId: "confirm-v4" }]));
    click("确认任务组合"); const html = await settle();
    expect(h.post).not.toHaveBeenCalled(); expect(props.onRefresh).not.toHaveBeenCalled();
    expect(html).toContain("任务版本已变化"); expect(h.textareas.get("mission-combination-round")!.value).toBe("依赖与责任边界已核对");
  });
  it("轮询先更新版本也不能把旧核对结论静默绑定新任务组合", async () => {
    const current = reviewing(); const { open, click, text, settle } = setup(current, [confirm]); await open();
    text("mission-combination-round", "依赖与责任边界已核对");
    h.get.mockResolvedValue(reply({ ...current, version: 4 }, [{ ...confirm, actionId: "confirm-v4" }])); h.poll!(); const html = await settle();
    expect(h.textareas.get("mission-combination-round")!.value).toBe("依赖与责任边界已核对"); expect(html).toContain("任务版本已变化");
    expect(h.buttons.get("确认任务组合")!.disabled).toBe(true);
    click("确认任务组合", true); await settle(); expect(h.post).not.toHaveBeenCalled();
    click("已核对最新报告"); click("确认任务组合"); await settle();
    expect(h.post).toHaveBeenCalledExactlyOnceWith("/api/mission-rounds/actions/execute", { body: { actionId: "confirm-v4", input: { note: "依赖与责任边界已核对" } } });
  });
});
