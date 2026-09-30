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
vi.mock("./DictationControls", () => ({ DictationControls: () => null }));
vi.mock("./useDictation", () => ({ useDictation: () => ({ active: false, clearError: vi.fn() }), withDictation: (input: string, text: string) => input + text }));

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
    label: "孙铭泽 · 10月任务", channels: [{ id: "agent", kind: "agent", label: "我的 Agent", unread: 0 }], channel: "agent", onChannel: vi.fn(),
    narrow: false, mobileOpen: false, onMobileOpen: vi.fn(), references: [], onHeightChange: vi.fn(),
    textQuotes: [quote], onRemoveQuotes: vi.fn(), prefill, onPrefillUsed: vi.fn(), draftOwnerId: "sun",
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
  it("发送时携带原文与来源，但成功前引用仍在，成功后只清本次引用", async () => {
    const { props, send, render, input, submit } = setup(); render(); input("请明确这段的验收方式"); await submit();
    expect(readQuotedMessage(send.mock.calls[0][0])).toEqual({ message: "请明确这段的验收方式", quotes: [{ ...quote, id: "sent-0" }] });
    expect(send.mock.calls[0][1]).toEqual([]);
    expect(props.onRemoveQuotes).toHaveBeenCalledWith(["quote-1"]);
    expect(h.field!.value).toBe("");
  });
  it("发送失败保留草稿和引用，不产生公开反馈", async () => {
    const { props, send, render, input, submit } = setup(); send.mockResolvedValue(false);
    render(); input("请明确验收方式"); await submit();
    expect(h.field!.value).toBe("请明确验收方式");
    expect(props.onRemoveQuotes).not.toHaveBeenCalled();
  });
  it("一次发送未返回时新草稿、新引用都保留，成功不误清后来选择", async () => {
    const { props, send, render, input } = setup();
    let finish!: (value: boolean) => void; send.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(); input("原来的问题"); h.form!.onSubmit(); render();
    input("接下来还要问"); props.textQuotes = [...props.textQuotes!, { ...quote, id: "quote-2" }]; render();
    h.form!.onSubmit(); expect(send).toHaveBeenCalledOnce();
    finish(true); await Promise.resolve(); await Promise.resolve(); render();
    expect(h.field!.value).toBe("接下来还要问");
    expect(props.onRemoveQuotes).toHaveBeenCalledExactlyOnceWith(["quote-1"]);
  });
  it("晚到的发送失败不覆盖用户新写的草稿", async () => {
    const { props, send, render, input } = setup();
    let finish!: (value: boolean) => void; send.mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    render(); input("原来的问题"); h.form!.onSubmit(); render(); input("新写的问题");
    finish(false); await Promise.resolve(); await Promise.resolve(); render();
    expect(h.field!.value).toBe("新写的问题");
    expect(props.onRemoveQuotes).not.toHaveBeenCalled();
  });
});
