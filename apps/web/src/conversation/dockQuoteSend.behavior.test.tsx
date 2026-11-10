import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ConversationData } from "./useConversation";
import type { TextQuote } from "./quotes";

/**
 * D5：全局输入条带引用发送 —— 按下发送的同一刻文字与引用一起清空；服务端没接下时都放回去，不覆盖期间的新输入。
 * 没有 jsdom：hook 桩 + 静态渲染；输入条里那个 <form> 的 onSubmit 从 JSX 运行时截下来直接调用。
 */
const h = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  field: null as { value: string; onChange: (event: { target: { value: string } }) => void } | null,
  form: null as { onSubmit: (event: { preventDefault: () => void }) => void } | null,
  storage: new Map<string, string>(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.stateIndex++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (update: unknown) => {
        const next = typeof update === "function" ? (update as (value: unknown) => unknown)(h.states[index]) : update;
        if (!Object.is(next, h.states[index])) h.dirty = true;
        h.states[index] = next;
      }];
    },
    useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
    useLayoutEffect: () => {},
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const index = h.effectIndex++, previous = h.dependencies[index];
      if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
        h.dependencies[index] = deps; h.queued.push(effect);
      }
    },
  };
});
const { captureForm } = vi.hoisted(() => ({
  captureForm: <T,>(fn: T) => ((type: unknown, props: { onSubmit?: unknown }, ...rest: unknown[]) => {
    if (type === "form") h.form = props as NonNullable<typeof h.form>;
    return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
  }) as unknown as T,
}));
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: captureForm(actual.jsx), jsxs: captureForm(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: captureForm(actual.jsxDEV) };
});
vi.mock("@heroui/react", () => ({ TextArea: (props: NonNullable<typeof h.field>) => {
  h.field = props; return <textarea value={props.value} readOnly />;
} }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: (props: { children?: ReactNode; "aria-label"?: string }) => <button aria-label={props["aria-label"]}>{props.children}</button> }));
vi.mock("./useDictation", () => ({ useDictation: () => ({ active: false, polishing: false, live: true, phase: "idle", error: null, marks: [], levels: [], clearError: vi.fn(), start: vi.fn(), cancel: vi.fn(), stop: vi.fn(), finish: vi.fn(), settle: vi.fn(), change: () => false, composition: vi.fn(), keyDown: () => false }),
  withDictation: (input: string, text: string) => input + text }));
vi.mock("./DictationControls", () => ({ DictationControls: () => null }));
vi.mock("./references", () => ({ ReferenceTray: ({ quotes }: { quotes?: ReactNode }) => <div data-tray>{quotes}</div> }));
vi.mock("./QuoteChips", () => ({ QuoteChips: ({ quotes }: { quotes: TextQuote[] }) => <span data-quote-count={quotes.length} /> }));
vi.mock("./ConversationAttachments", () => ({ AttachButton: () => null, AttachmentStatus: () => null }));

import { ConversationDock } from "./ConversationDock";
import { readQuotedMessage } from "./quotes";

const quote: TextQuote = { id: "quote-1", text: "先保灯塔交付", source: { scope: "global" } };

beforeEach(() => {
  h.states = []; h.refs = []; h.dependencies = []; h.storage.clear(); h.field = null; h.form = null;
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: (key: string) => h.storage.get(key) ?? null, setItem: (key: string, value: string) => h.storage.set(key, value), removeItem: (key: string) => h.storage.delete(key) });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  let finish!: (accepted: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const data = { scope: "global", messages: [], status: "idle", streaming: false, partial: "", stage: "thinking", startedAt: 0, error: null, lastReply: null,
    historyStatus: "ready", attachments: [], uploading: false, attachmentError: null, uploadFiles: vi.fn(), removeAttachment: vi.fn(), send, stop: vi.fn() } as unknown as ConversationData;
  const props: ComponentProps<typeof ConversationDock> = { data, label: "天枢", global: true, detail: false, keyboard: true, onKeyboardChange: vi.fn(),
    historyOpen: true, references: [], onRemoveReference: vi.fn(), onClearReferences: vi.fn(), onRestoreReferences: vi.fn(),
    textQuotes: [quote], onRemoveQuotes: vi.fn(), onRestoreQuotes: vi.fn() };
  const render = () => {
    for (let pass = 0; pass < 6; pass++) {
      h.stateIndex = 0; h.refIndex = 0; h.effectIndex = 0; h.queued = []; h.dirty = false;
      const html = renderToStaticMarkup(<ConversationDock {...props} />);
      h.queued.forEach((effect) => effect());
      if (!h.dirty) return html;
    }
    throw new Error("dock did not settle");
  };
  const input = (value: string) => { h.field!.onChange({ target: { value } }); render(); };
  const press = () => h.form!.onSubmit({ preventDefault: () => undefined });
  const resolve = async (accepted: boolean) => { finish(accepted); await Promise.resolve(); await Promise.resolve(); render(); };
  return { props, send, render, input, press, resolve };
}

describe("全局输入条：带引用发送（D5）", () => {
  it("按下发送的同一刻，文字与引用一起清空，不等回答结束", async () => {
    const { props, send, render, input, press, resolve } = setup();
    render(); input("这段怎么落实？");
    press(); render();
    expect(readQuotedMessage((send.mock.calls[0] as unknown[])[0] as string)).toEqual({ message: "这段怎么落实？", quotes: [{ ...quote, id: "sent-0" }] });
    expect(props.onRemoveQuotes).toHaveBeenCalledExactlyOnceWith(["quote-1"]);
    expect(h.field!.value).toBe("");
    await resolve(true);
    expect(props.onRemoveQuotes).toHaveBeenCalledOnce();
    expect(props.onRestoreQuotes).not.toHaveBeenCalled();
  });

  it("服务端没接下：文字和引用都放回去", async () => {
    const { props, render, input, press, resolve } = setup();
    render(); input("这段怎么落实？");
    press(); render();
    await resolve(false);
    expect(h.field!.value).toBe("这段怎么落实？");
    expect(props.onRestoreQuotes).toHaveBeenCalledExactlyOnceWith([quote]);
  });

  it("失败晚到时不覆盖期间新写的文字（引用交给宿主合并，宿主不覆盖新加的引用）", async () => {
    const { props, render, input, press, resolve } = setup();
    render(); input("这段怎么落实？");
    press(); render();
    input("换个问法");
    await resolve(false);
    expect(h.field!.value).toBe("换个问法");
    expect(props.onRestoreQuotes).toHaveBeenCalledExactlyOnceWith([quote]);
  });

  it("没有引用时发送不碰引用", async () => {
    const { props, render, input, press, resolve } = setup();
    props.textQuotes = [];
    render(); input("只是问一句");
    press(); render();
    await resolve(false);
    expect(props.onRemoveQuotes).not.toHaveBeenCalled();
    expect(props.onRestoreQuotes).not.toHaveBeenCalled();
  });
});
