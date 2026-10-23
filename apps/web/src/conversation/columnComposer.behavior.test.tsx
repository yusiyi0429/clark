import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ConversationData } from "./useConversation";
import type { QuotePrefill, TextQuote } from "./quotes";

const h = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  field: null as { value: string; onChange: (event: { target: { value: string } }) => void } | null,
  form: null as { onSubmit: () => void } | null, frames: [] as (() => void)[],
  inputElement: { value: "", focus: vi.fn(), setSelectionRange: vi.fn() }, storage: new Map<string, string>(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = h.stateIndex++;
    if (!(index in h.states)) h.states[index] = typeof initial === "function" ? initial() : initial;
    return [h.states[index], (update: unknown) => {
      const next = typeof update === "function" ? update(h.states[index]) : update;
      if (!Object.is(next, h.states[index])) h.dirty = true;
      h.states[index] = next;
    }];
  }, useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
    const index = h.effectIndex++, previous = h.dependencies[index];
    if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
      h.dependencies[index] = deps; h.queued.push(effect);
    }
  } };
});
vi.mock("@heroui/react", () => ({ TextArea: (props: NonNullable<typeof h.field> & { ref: { current: unknown } }) => {
  h.field = props; h.inputElement.value = props.value; props.ref.current = h.inputElement;
  return <textarea value={props.value} readOnly />;
} }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children }: { children?: ReactNode }) => <button>{children}</button> }));
vi.mock("./ComposerPill", () => ({ pillStyles: {}, usePillRows: () => 1,
  ComposerPill: (props: NonNullable<typeof h.form> & { field: ReactNode; references?: ReactNode; action: ReactNode; leading?: ReactNode }) => {
    h.form = props; return <form>{props.references}{props.field}{props.leading}{props.action}</form>;
  }, ChannelSwitch: () => null, ComposerAction: () => null }));
vi.mock("./QuoteChips", () => ({ QuoteChips: ({ quotes }: { quotes: TextQuote[] }) => <span data-quote-count={quotes.length}>引用</span> }));
vi.mock("./ConversationColumn", () => ({ columnComposerClass: "column", pressChannel: vi.fn() }));
vi.mock("./ConversationAttachments", () => ({ AttachButton: () => null }));

import { ColumnComposer } from "./ColumnComposer";
import { readQuotedMessage } from "./quotes";

const quote: TextQuote = { id: "quote-1", text: "原文：形成可复核的界面与权限证据。", source: { scope: "mission-card:card-01", missionId: "mission-01", field: "outcome", sourceVersion: 3, sourceRound: 1 } };
beforeEach(() => {
  h.states = []; h.refs = []; h.dependencies = []; h.frames = []; h.storage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { h.frames.push(callback); return h.frames.length; });
  vi.stubGlobal("localStorage", { getItem: (key: string) => h.storage.get(key), setItem: (key: string, value: string) => h.storage.set(key, value), removeItem: (key: string) => h.storage.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

function setup(prefill: QuotePrefill | null = null) {
  const send = vi.fn().mockResolvedValue(true);
  const props: ComponentProps<typeof ColumnComposer> = {
    data: { scope: "mission-card:card-01", streaming: false, attachments: [], send, stop: vi.fn() } as unknown as ConversationData,
    label: "孙铭泽 · 10月任务", channels: [{ id: "agent", kind: "agent", label: "天枢", unread: 0 }], channel: "agent", onChannel: vi.fn(),
    narrow: false, mobileOpen: false, onMobileOpen: vi.fn(), references: [], onHeightChange: vi.fn(),
    textQuotes: [quote], onRemoveQuotes: vi.fn(), onRestoreQuotes: vi.fn(), prefill, onPrefillUsed: vi.fn(), draftOwnerId: "sun",
  };
  const render = () => {
    let html = "";
    for (let pass = 0; pass < 6; pass++) {
      h.stateIndex = 0; h.refIndex = 0; h.effectIndex = 0; h.dirty = false; h.queued = [];
      html = renderToStaticMarkup(<ColumnComposer {...props} />);
      h.queued.forEach((effect) => effect());
      if (!h.dirty) return html;
    }
    throw new Error("Composer did not settle");
  };
  const input = (value: string) => { h.field!.onChange({ target: { value } }); render(); };
  const submit = async () => { h.form!.onSubmit(); await Promise.resolve(); await Promise.resolve(); render(); };
  return { props, send, render, input, submit };
}

describe("文字引用不混进二级页输入", () => {
  it("引用保留用户原草稿，只聚焦输入，不自动发送", () => {
    h.storage.set("tianshu-conversation-draft-v1:sun:mission-card:card-01", "我自己的问题");
    const { props, send, render } = setup({ text: quote.text, nonce: 1 });
    const html = render(); h.frames.forEach((frame) => frame());
    expect(h.field!.value).toBe("我自己的问题");
    expect(html).not.toContain(quote.text);
    expect(props.onPrefillUsed).toHaveBeenCalledWith(1);
    expect(h.inputElement.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(h.inputElement.setSelectionRange).toHaveBeenCalledWith(6, 6);
    expect(send).not.toHaveBeenCalled();
  });
  it("发送时携带原文与来源；按下发送的同一刻文字与引用一起清空，不等回答（D5）", async () => {
    const { props, send, render, input } = setup(); render(); input("请明确这段的验收方式");
    let finish!: (value: boolean) => void; send.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    h.form!.onSubmit(); render();
    expect(readQuotedMessage(send.mock.calls[0][0])).toEqual({ message: "请明确这段的验收方式", quotes: [{ ...quote, id: "sent-0" }] });
    expect(send.mock.calls[0][1]).toEqual([]);
    // 回答还没结束：引用已经清掉了。
    expect(props.onRemoveQuotes).toHaveBeenCalledExactlyOnceWith(["quote-1"]);
    expect(h.field!.value).toBe("");
    finish(true); await Promise.resolve(); await Promise.resolve(); render();
    expect(props.onRemoveQuotes).toHaveBeenCalledOnce();
    expect(props.onRestoreQuotes).not.toHaveBeenCalled();
  });
  it("发送失败（服务端没接下）：草稿和引用都放回去，不产生公开反馈", async () => {
    const { props, send, render, input, submit } = setup(); send.mockResolvedValue(false);
    render(); input("请明确验收方式"); await submit();
    expect(h.field!.value).toBe("请明确验收方式");
    expect(props.onRemoveQuotes).toHaveBeenCalledWith(["quote-1"]);
    expect(props.onRestoreQuotes).toHaveBeenCalledExactlyOnceWith([quote]);
  });
  it("一次发送未返回时新草稿、新引用都保留，成功不误清后来选择", async () => {
    const { props, send, render, input } = setup();
    let finish!: (value: boolean) => void; send.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(); input("原来的问题"); h.form!.onSubmit(); render();
    input("接下来还要问"); props.textQuotes = [{ ...quote, id: "quote-2" }]; render();
    h.form!.onSubmit(); expect(send).toHaveBeenCalledOnce();
    finish(true); await Promise.resolve(); await Promise.resolve(); render();
    expect(h.field!.value).toBe("接下来还要问");
    expect(props.onRemoveQuotes).toHaveBeenCalledExactlyOnceWith(["quote-1"]);
    expect(props.onRestoreQuotes).not.toHaveBeenCalled();
  });
  it("晚到的发送失败不覆盖用户新写的草稿；引用交回去恢复（由宿主合并，不覆盖新引用）", async () => {
    const { props, send, render, input } = setup();
    let finish!: (value: boolean) => void; send.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(); input("原来的问题"); h.form!.onSubmit(); render(); input("新写的问题");
    finish(false); await Promise.resolve(); await Promise.resolve(); render();
    expect(h.field!.value).toBe("新写的问题");
    expect(props.onRestoreQuotes).toHaveBeenCalledExactlyOnceWith([quote]);
  });
});

describe("月度计划逐段评审：就地入口只是召唤这一个输入条", () => {
  it("新引用挂上：光标进输入框，不发送、不动草稿", () => {
    h.storage.set("tianshu-conversation-draft-v1:sun:mission-card:card-01", "我自己的问题");
    const { send, render } = setup({ text: quote.text, nonce: 2 });
    render(); h.frames.forEach((frame) => frame());
    expect(h.inputElement.focus).toHaveBeenCalledOnce();
    expect(h.field!.value).toBe("我自己的问题");
    expect(send).not.toHaveBeenCalled();
  });
  it("「按意见重写」：代一号位直接发出这一句（带它自己的引用），输入框草稿和已挂的引用块不动", async () => {
    h.storage.set("tianshu-conversation-draft-v1:sun:mission-card:card-01", "还没发的话");
    const own: TextQuote = { id: "ask-3", text: "本月公司结果原文", source: { objectType: "monthly-plan", objectId: "p1", field: "companyOutcome", intent: "plan-rewrite" } };
    const onResult = vi.fn();
    const message = ["按以下意见重写「本月公司结果」：", "1. 写清现金流"].join("\n");
    const { props, send, render } = setup({ text: "", nonce: 3, send: { message, quotes: [own], onResult } });
    render(); await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledOnce();
    expect(readQuotedMessage(send.mock.calls[0][0])).toEqual({ message, quotes: [{ ...own, id: "sent-0" }] });
    expect(h.field!.value).toBe("还没发的话");
    expect(props.onRemoveQuotes).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(true);
  });
  it("回答进行中不代发，回报没接下", () => {
    const onResult = vi.fn();
    const { props, send, render } = setup({ text: "", nonce: 4, send: { message: "按以下意见重写「本月公司结果」：1. x", quotes: [], onResult } });
    (props.data as { streaming: boolean }).streaming = true;
    render();
    expect(send).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledWith(false);
  });
});

describe("回答末尾的选项（10/11 首演版定稿）", () => {
  it("点选项：输入框填入「选择：{方案名}」并聚焦，不发送；别的对话范围的点击不进来", async () => {
    const listeners = new Map<string, (event: Event) => void>();
    vi.stubGlobal("window", { addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener), removeEventListener: vi.fn(),
      dispatchEvent: (event: Event) => { listeners.get(event.type)?.(event); return true; } });
    const { chooseAnswerOption } = await import("./answerOptions");
    const { send, render } = setup(); render();
    chooseAnswerOption("issue:other", "维持现状"); render();
    expect(h.field!.value).toBe("");
    chooseAnswerOption("mission-card:card-01", "正式采用"); render(); h.frames.forEach((frame) => frame());
    expect(h.field!.value).toBe("选择：正式采用");
    expect(h.inputElement.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(h.inputElement.setSelectionRange).toHaveBeenCalledWith(7, 7);
    expect(send).not.toHaveBeenCalled();
  });
});
