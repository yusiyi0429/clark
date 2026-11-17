import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Buddy } from "@/components/buddy/useBuddy";
import type { ConversationData } from "@/conversation/useConversation";

/**
 * 页头在场（设计 4.2、5.2）。没有 jsdom：
 * - 画出来看样子：renderToStaticMarkup；
 * - 点和计时：React 的 useState / useRef / useEffect 只在 hooks.active 时换成按调用顺序记账的版本，直接调组件、hook，按真实的点击处理器走。
 */
type Slot = { deps?: readonly unknown[]; ran?: readonly unknown[]; run?: () => void | (() => void); cleanup?: void | (() => void) };
const hooks = vi.hoisted(() => {
  let active = false;
  let cursor = 0;
  let slots: unknown[] = [];
  let queue: Slot[] = [];
  return {
    get active() { return active; },
    begin() { active = true; cursor = 0; },
    end() { active = false; },
    reset() { active = false; cursor = 0; slots = []; queue = []; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(slots[index]) : value; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      const slot = (slots[index] ??= {}) as Slot;
      slot.run = run;
      slot.deps = deps;
      queue.push(slot);
    },
    /** 提交：依赖变了的 effect 先清上一次再跑。 */
    flush() {
      for (const slot of queue) {
        if (slot.ran && slot.deps && slot.deps.every((dep, i) => Object.is(dep, slot.ran![i]))) continue;
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.cleanup = slot.run!();
        slot.ran = slot.deps;
      }
      queue = [];
    },
  };
});
const env = vi.hoisted(() => ({
  meeting: { listening: false, clock: null as string | null, href: null as string | null },
  dictation: null as { level: number } | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial?: unknown) => (hooks.active ? hooks.useState(initial) : react.useState(initial)),
    useRef: (initial?: unknown) => (hooks.active ? hooks.useRef(initial) : react.useRef(initial)),
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => (hooks.active ? hooks.useEffect(run, deps) : react.useEffect(run, deps)),
    useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, get: () => T, server?: () => T) =>
      (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
vi.mock("./meetingState", () => ({ useHomeMeetingState: () => env.meeting }));
vi.mock("@/conversation/dictationSignal", () => ({ useDictationSignal: () => env.dictation }));

import { StepList } from "@/components/steps/StepList";
import { markScrolled } from "@/components/rail/ChatPane";
import { WorkTimeline } from "@/components/work/WorkTimeline";
import { revealTurn } from "@/conversation/ReplyBubbles";
import { Presence, usePresenceState } from "./Presence";

const css = readFileSync(new URL("../../styles/presence.module.css", import.meta.url), "utf8");
const chatCss = readFileSync(new URL("../../styles/v2-chat.module.css", import.meta.url), "utf8");
const miles = { name: "小天", form: "miles" } as Buddy;

const data = (extra: Partial<ConversationData> = {}) => ({
  scope: "global", status: "idle", streaming: false, thinking: false, partial: "", stage: "thinking", startedAt: 0,
  steps: [], plan: null, progress: undefined, thought: null, stop: vi.fn(), ...extra,
}) as unknown as ConversationData;
const answering = (extra: Partial<ConversationData> = {}) =>
  data({ status: "streaming", streaming: true, thinking: true, startedAt: Date.now() - 12_000, ...extra });

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement(node) ? text((node as Element).props.children as ReactNode) : "";
}
/** 调一次组件（不经 React 渲染），拿到它这一层的元素树。 */
function call(props: Parameters<typeof Presence>[0]) {
  hooks.begin();
  try { return Presence(props) as ReactNode; } finally { hooks.end(); }
}
const button = (tree: ReactNode, label: string) => elements(tree).find((element) => element.type === "button" && text(element).includes(label));
const markState = (tree: ReactNode) => elements(tree).find((element) => "state" in element.props && "buddy" in element.props)?.props.state;

afterEach(() => {
  hooks.reset();
  env.meeting = { listening: false, clock: null, href: null };
  env.dictation = null;
  vi.useRealTimers();
});

describe("页头在场：形象钉在正中，状态胶囊挂在下面（设计 4.2）", () => {
  it("形象钉在页头正中，状态胶囊挂在下面，出现前后形象不挪", () => {
    const idle = renderToStaticMarkup(<Presence buddy={miles} data={data()} go={vi.fn()} />);
    const busy = renderToStaticMarkup(<Presence buddy={miles} data={answering()} go={vi.fn()} />);
    // 空闲只有形象，没有空胶囊；回答中多一颗胶囊，跟在形象后面。
    expect(idle).toMatch(/^<div[^>]*data-presence=""[^>]*><span[^>]*data-place="head"/);
    expect(idle).not.toContain('data-testid="presence-pill"');
    expect(busy).toMatch(/^<div[^>]*data-presence=""[^>]*><span[^>]*data-place="head"/);
    expect(busy.indexOf('data-testid="presence-pill"')).toBeGreaterThan(busy.indexOf('data-place="head"'));
    // 胶囊挂在形象后面另一块里（hang），不在形象的排版里：形象那一块前后是同一个位置。
    expect(busy).toMatch(/<div class="[^"]*hang[^"]*"><div[^>]*data-testid="presence-pill"/);
    const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{[^}]*\\}`))?.[0] ?? "";
    // 页头三栏，正中那一栏永远在正中；胶囊挂在形象下面 6px，绝对定位、居中、不撑高页头。
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
    expect(rule("hang")).toMatch(/position: absolute/);
    expect(rule("hang")).toMatch(/top: calc\(100% \+ 6px\)/);
    expect(rule("hang")).toMatch(/left: 50%/);
    expect(rule("hang")).toMatch(/translateX\(-50%\)/);
    // 磨砂浮在对话上：--surface 82% + blur(12px) + 发丝线；不写字号、不写死颜色。
    expect(rule("pill")).toContain("color-mix(in oklab, var(--surface) 82%, transparent)");
    expect(rule("pill")).toContain("blur(12px)");
    expect(rule("pill")).toContain("var(--hairline)");
    // 胶囊最宽是页头（对话栏）的宽，不按窗口：右边面板打开时也出不了对话栏。
    expect(css).toMatch(/\.head\[data-flush\] \{[^}]*container-type: inline-size/);
    expect(rule("pill")).toMatch(/max-width: 100cqw/);
    expect(css).not.toMatch(/100vw/);
    expect(css).not.toMatch(/font-size|font-weight/);
    expect(css.match(/#[0-9a-f]{3,8}\b|rgb\(/gi)).toBeNull();
    // 减少动态效果时胶囊不做入场动画。
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/\[data-reduce-motion='true'\]/);
  });

  it("只有主线页头放形象：项目对话页头正中没有形象，干活时胶囊挂在和主线同一个位置（页头下面）", () => {
    const project = (extra: Partial<ConversationData> = {}) => ({ ...data(), scope: "project:p1", ...extra }) as ConversationData;
    const idle = renderToStaticMarkup(<Presence buddy={miles} data={project()} go={vi.fn()} />);
    expect(idle).not.toContain("data-place");
    expect(idle).not.toContain('data-testid="presence-pill"');
    const busy = renderToStaticMarkup(<Presence buddy={miles} data={answering({ scope: "project:p1" })} go={vi.fn()} />);
    const mainBusy = renderToStaticMarkup(<Presence buddy={miles} data={answering()} go={vi.fn()} />);
    expect(busy).not.toContain("data-place");
    // 同一个在场块、同一个挂胶囊的那一块（hang），只是上面没有形象：去掉主线那颗形象，两边一模一样。
    const container = (html: string) => html.match(/^<div[^>]*>/)![0];
    expect(container(busy)).toBe(container(mainBusy));
    const hang = (html: string) => html.match(/<div class="[^"]*hang[^"]*">[^]*$/)![0];
    expect(hang(busy)).toBe(hang(mainBusy));
    // 胶囊的位置只有一条规则：挂在页头正中下面 6px，项目对话不另挪（不进页头那一行，盖不住标题和右边按钮）。
    expect(css.match(/\.hang \{/g)).toHaveLength(1);
    expect(css).not.toMatch(/data-bare|\.presence\[[^\]]*\] \.hang/);
    env.meeting = { listening: true, clock: "12:34", href: "/me/work/meetings/m1" };
    expect(renderToStaticMarkup(<Presence buddy={miles} data={project()} go={vi.fn()} />)).toMatch(/^<div[^>]*data-presence=""><div class="[^"]*hang[^"]*">[^]*● 12:34 在录/);
    // 主线照旧：形象钉住。
    expect(renderToStaticMarkup(<Presence buddy={miles} data={data()} go={vi.fn()} />)).toContain('data-place="head"');
  });

  it("回答中写在做什么、用时和停止；点停止调 stop", () => {
    const steps = [{ id: "1", label: "读本月目标", status: "done" as const }, { id: "2", label: "对一下日程", status: "active" as const }];
    const doing = answering({ steps });
    const tree = call({ buddy: miles, data: doing, go: vi.fn() });
    const pill = elements(tree).find((element) => element.props["data-testid"] === "presence-pill")!;
    expect(text(pill)).toBe("对一下日程 · 12 秒停止");
    expect(markState(tree)).toBe("thinking");
    (button(tree, "停止")!.props.onClick as () => void)();
    expect(doing.stop).toHaveBeenCalledTimes(1);
    // 点胶囊（不是停止）：下面落一小块步骤，再点收回。
    expect(elements(tree).some((element) => element.props["data-testid"] === "presence-detail")).toBe(false);
    (button(tree, "对一下日程")!.props.onClick as () => void)();
    const open = call({ buddy: miles, data: doing, go: vi.fn() });
    const detail = elements(open).find((element) => element.props["data-testid"] === "presence-detail");
    expect(elements(detail!.props.children as ReactNode).find((element) => element.type === StepList)?.props.steps).toBe(steps);
    (button(open, "对一下日程")!.props.onClick as () => void)();
    expect(elements(call({ buddy: miles, data: doing, go: vi.fn() })).some((element) => element.props["data-testid"] === "presence-detail")).toBe(false);

    hooks.reset();
    // 还没拿到具体阶段：只写用时，不写笼统的词。
    const bare = elements(call({ buddy: miles, data: answering(), go: vi.fn() })).find((element) => element.props["data-testid"] === "presence-pill")!;
    expect(text(bare)).toBe("12 秒停止");
    hooks.reset();
    // 第一个气泡出来以后（对话那边报了 revealTurn）没有具体在做的：在回答 · 用时；形象是正在输入。
    const replying = answering({ partial: "好", stage: "answering" });
    expect(markState(call({ buddy: miles, data: replying, go: vi.fn() }))).toBe("thinking");
    revealTurn(replying.scope, replying.startedAt);
    hooks.reset();
    const typing = call({ buddy: miles, data: replying, go: vi.fn() });
    expect(text(elements(typing).find((element) => element.props["data-testid"] === "presence-pill"))).toBe("在回答 · 12 秒停止");
    expect(markState(typing)).toBe("typing");
  });

  it("开会录音时写「● 12:34 在录」，点了去会议页", () => {
    env.meeting = { listening: true, clock: "12:34", href: "/me/work/meetings/m1" };
    const go = vi.fn();
    const tree = call({ buddy: miles, data: data(), go });
    expect(markState(tree)).toBe("listening");
    const rec = button(tree, "在录")!;
    expect(text(rec)).toBe("● 12:34 在录");
    (rec.props.onClick as () => void)();
    expect(go).toHaveBeenCalledWith("/me/work/meetings/m1");

    hooks.reset();
    env.meeting = { listening: false, clock: null, href: null };
    // 听写开着：形象也在听，但没有在录的胶囊。
    env.dictation = { level: 0.4 };
    const dictating = call({ buddy: miles, data: data(), go });
    expect(markState(dictating)).toBe("listening");
    expect(elements(dictating).some((element) => element.props["data-testid"] === "presence-pill")).toBe(false);
  });

  it("滚离顶部才淡出：停在最上面不淡出、不多留白", () => {
    // 对话一滚动就按 scrollTop 记一下有没有离开顶部（不经 React 重画）。
    const log = { scrollTop: 0, toggleAttribute: vi.fn() };
    markScrolled(log as unknown as HTMLElement);
    expect(log.toggleAttribute).toHaveBeenLastCalledWith("data-scrolled", false);
    log.scrollTop = 120;
    markScrolled(log as unknown as HTMLElement);
    expect(log.toggleAttribute).toHaveBeenLastCalledWith("data-scrolled", true);
    // 只在有在场的对话里、离开顶部时，顶上 56px 淡出；不另加顶部留白。
    const rules = chatCss.match(/\.pane:has\(\.head \[data-presence\]\)[^{]*\{[^}]*\}/g) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/^\.pane:has\(\.head \[data-presence\]\) \.log\[data-scrolled\] \{/);
    expect(rules[0]).toContain("mask-image: linear-gradient(to bottom, transparent 0, black 56px)");
    expect(rules[0]).not.toMatch(/padding/);
  });

  it("新首页对话里思考只在胶囊下面，对话里没有", () => {
    const thought = { text: "先看本月目标里挂着哪几件，再对日程。", seconds: null };
    const timeline = (extra: Partial<ConversationData>) => renderToStaticMarkup(<WorkTimeline data={answering({
      messages: [{ sequence: 1, role: "user", content: "帮我排一下" }], send: vi.fn(), rescope: vi.fn(), ...extra,
    } as Partial<ConversationData>)} blocks={[]} />);
    // 回答中、出字前：对话里没有思考摘要。
    expect(timeline({ thought })).not.toContain(thought.text);
    // 出字以后、这一轮结束以后：也没有「已思考 N 秒」。
    expect(timeline({ thought: { ...thought, seconds: 4 }, partial: "好", thinking: false })).not.toContain("conversation-thought-toggle");
    expect(timeline({ thought: { ...thought, seconds: 4 }, status: "complete", streaming: false, thinking: false,
      messages: [{ sequence: 1, role: "user", content: "帮我排一下" }, { sequence: 2, role: "assistant", content: "好" }] } as Partial<ConversationData>)).not.toContain("conversation-thought-toggle");
    // 胶囊下面那一块里有。
    hooks.reset();
    const data = answering({ thought });
    (button(call({ buddy: miles, data, go: vi.fn() }), "秒")!.props.onClick as () => void)();
    const detail = elements(call({ buddy: miles, data, go: vi.fn() })).find((element) => element.props["data-testid"] === "presence-detail")!;
    expect(elements(detail.props.children as ReactNode).find((element) => element.props.text === thought.text)).toBeDefined();
  });

  it("回答结束 1.2 秒内是 done，之后 idle", () => {
    vi.useFakeTimers();
    const state = (status: string, streaming = status === "streaming") => {
      hooks.begin();
      try { return usePresenceState(data({ status, streaming } as Partial<ConversationData>), true); } finally { hooks.end(); hooks.flush(); }
    };
    expect(state("idle")).toBe("idle");
    expect(state("streaming")).toBe("typing");
    expect(state("complete")).toBe("done");
    vi.advanceTimersByTime(1199);
    expect(state("complete")).toBe("done");
    vi.advanceTimersByTime(1);
    expect(state("complete")).toBe("idle");

    // 1.2 秒内又开了一轮：done 立刻让给这一轮。
    expect(state("streaming")).toBe("typing");
    expect(state("complete")).toBe("done");
    vi.advanceTimersByTime(500);
    expect(state("streaming")).toBe("typing");
    vi.advanceTimersByTime(1000);
    expect(state("streaming")).toBe("typing");

    // 停下、出错不算做完。
    expect(state("aborted")).toBe("idle");
    expect(state("streaming")).toBe("typing");
    expect(state("failed")).toBe("idle");
  });
});
