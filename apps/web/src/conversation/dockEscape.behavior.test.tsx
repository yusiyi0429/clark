import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ConversationData } from "./useConversation";

/**
 * 首页对话层的 Esc 一层一层退：放大（深度讨论）着，输入框里的 Esc 先退出放大；再按一次才收起对话层。
 * 没有 jsdom：hook 桩 + 静态渲染，输入框的 onKeyDown 从 TextArea 桩上截下来直接调用。
 */
const h = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  field: null as { onKeyDown: (event: KeyEvent) => void } | null,
}));
type KeyEvent = { key: string; preventDefault: () => void; stopPropagation: () => void; shiftKey?: boolean; nativeEvent: { isComposing: boolean; keyCode: number }; currentTarget: unknown };
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
vi.mock("@heroui/react", () => ({ TextArea: (props: NonNullable<typeof h.field>) => { h.field = props; return <textarea readOnly />; } }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: (props: { children?: ReactNode; "aria-label"?: string }) => <button aria-label={props["aria-label"]}>{props.children}</button> }));
vi.mock("./useDictation", () => ({ useDictation: () => ({ active: false, polishing: false, live: true, phase: "idle", error: null, marks: [], clearError: vi.fn(), start: vi.fn(), cancel: vi.fn(), stop: vi.fn(), finish: vi.fn(), settle: vi.fn(), change: () => false, composition: vi.fn(), keyDown: () => false }),
  withDictation: (input: string, text: string) => input + text }));
vi.mock("./DictationControls", () => ({ DictationControls: () => null }));
vi.mock("./references", () => ({ ReferenceTray: () => null }));
vi.mock("./QuoteChips", () => ({ QuoteChips: () => null }));
vi.mock("./ConversationAttachments", () => ({ AttachButton: () => null, AttachmentStatus: () => null }));

import { ConversationDock } from "./ConversationDock";

beforeEach(() => {
  h.states = []; h.refs = []; h.dependencies = []; h.field = null;
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

function setup(extra: Partial<ComponentProps<typeof ConversationDock>> = {}) {
  const data = { scope: "global", messages: [], status: "idle", streaming: false, partial: "", stage: "thinking", startedAt: 0, error: null, lastReply: null,
    historyStatus: "ready", attachments: [], uploading: false, attachmentError: null, uploadFiles: vi.fn(), removeAttachment: vi.fn(), send: vi.fn(), stop: vi.fn() } as unknown as ConversationData;
  const props: ComponentProps<typeof ConversationDock> = { data, label: "天枢", global: true, detail: false, keyboard: true, onKeyboardChange: vi.fn(),
    historyOpen: true, references: [], onRemoveReference: vi.fn(), onClearReferences: vi.fn(), onRestoreReferences: vi.fn(), ...extra };
  for (let pass = 0; pass < 6; pass++) {
    h.stateIndex = 0; h.refIndex = 0; h.effectIndex = 0; h.queued = []; h.dirty = false;
    renderToStaticMarkup(<ConversationDock {...props} />);
    h.queued.forEach((effect) => effect());
    if (!h.dirty) break;
  }
  const escape = (composing = false) => {
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn(), nativeEvent: { isComposing: composing, keyCode: composing ? 229 : 27 }, currentTarget: {} };
    h.field!.onKeyDown(event);
    return event;
  };
  return { props, escape };
}

describe("首页输入框里的 Esc（一层一层退）", () => {
  it("普通对话层：Esc 收起对话层", () => {
    const { props, escape } = setup({ wide: false, onWideExit: vi.fn() });
    const event = escape();
    expect(props.onKeyboardChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(props.onWideExit).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("放大着：第一次 Esc 只退出放大，对话层留着；退出后再按才收起", () => {
    const { props, escape } = setup({ wide: true, onWideExit: vi.fn() });
    escape();
    expect(props.onWideExit).toHaveBeenCalledOnce();
    expect(props.onKeyboardChange).not.toHaveBeenCalled();
    const normal = setup({ wide: false, onWideExit: props.onWideExit });
    normal.escape();
    expect(normal.props.onKeyboardChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("组词中的 Esc 只取消组词，既不退出放大也不收起对话层", () => {
    const { props, escape } = setup({ wide: true, onWideExit: vi.fn() });
    const event = escape(true);
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(props.onWideExit).not.toHaveBeenCalled();
    expect(props.onKeyboardChange).not.toHaveBeenCalled();
  });
});
