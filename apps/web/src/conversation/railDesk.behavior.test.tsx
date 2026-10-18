import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ConversationData } from "./useConversation";

// 深度讨论（并排）在二级页右列上：什么时候有 ⤢、展开时右列拿到多宽、变窄自动收起、流式中切换不重挂、群聊也能展开。
const harness = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  rail: null as { channel: string; onChannel: (channel: string) => void; deskWidth?: number | null; onDesk?: (open: boolean) => void; headerAction?: unknown } | null,
  agent: null as { prefill: { text: string; nonce: number } | null; onPrefillUsed: () => void; data: ConversationData; onRestoreQuotes?: unknown } | null,
  group: null as { onSend: (body: string) => unknown } | null,
  privateSend: vi.fn().mockResolvedValue(true), groupSend: vi.fn().mockResolvedValue(true),
  column: { mode: "strip" as "strip" | "expanded", narrow: false, setMode: vi.fn() },
  conversation: {} as Record<string, unknown>,
  sheet: null as { onQuote?: (text: string) => void; onClose: () => void; composerRef?: unknown; notice?: string | null } | null,
  dock: null as { dockRef?: unknown; onRestoreQuotes?: unknown; keyboard: boolean; onKeyboardChange: (keyboard: boolean) => void;
    onDictationError?: (error: string | null) => void } | null,
  jumps: [] as { streaming?: boolean; visible: boolean }[],
  selected: null as { top: number; left: number; text: string } | null,
  toolbar: null as { label?: string; onQuote: () => void } | null,
  selectionOptions: null as unknown,
  deskWidth: null as number | null, scrollArgs: [] as unknown[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateIndex++;
      if (!(index in harness.states)) harness.states[index] = typeof initial === "function" ? initial() : initial;
      return [harness.states[index], (update: unknown) => {
        const next = typeof update === "function" ? update(harness.states[index]) : update;
        if (!Object.is(next, harness.states[index])) harness.dirty = true;
        harness.states[index] = next;
      }];
    },
    useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= { current: initial },
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const index = harness.effectIndex++, previous = harness.dependencies[index];
      if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
        harness.dependencies[index] = deps; harness.queued.push(effect);
      }
    },
  };
});
vi.mock("./useConversation", () => ({ useConversation: (scope: string) => ({ scope, messages: [], streaming: false,
  attachments: [], error: null, historyStatus: "ready", historyError: null, retryHistory: vi.fn(), send: harness.privateSend, ...harness.conversation }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./useMissionGroup", () => ({ useMissionGroup: () => ({ view: { members: [], entries: [] }, send: harness.groupSend }) }));
vi.mock("./useTaskGroup", () => ({ useThreadGroup: () => ({ view: { members: [], messages: [] }, catchUp: null }) }));
vi.mock("./useColumnMode", () => ({ useColumnMode: () => harness.column }));
vi.mock("./references", () => ({ useReferences: () => null }));
vi.mock("@/components/coagent/presence", () => ({ useListening: () => false }));
vi.mock("@/components/coagent/skin", () => ({ useCoAgentSkin: () => ["default"] }));
vi.mock("@/components/coagent/PresenceCapsule", () => ({ PresenceCapsule: () => null }));
vi.mock("./ConversationColumn", () => ({ conversationStyles: {}, ConversationColumn: (props: NonNullable<typeof harness.rail> & { children: ReactNode }) => {
  harness.rail = props; return <aside data-channel={props.channel}>{props.children}</aside>;
} }));
vi.mock("./desk/useDeskLayout", () => ({ useDeskColumnWidth: () => harness.deskWidth, useViewportWidth: () => 1440 }));
vi.mock("./ColumnComposer", () => ({ ColumnComposer: (props: NonNullable<typeof harness.agent>) => {
  harness.agent = props; return <div data-composer="private">{props.prefill?.text}</div>;
} }));
vi.mock("./MissionGroupComposer", () => ({ MissionGroupComposer: (props: NonNullable<typeof harness.group>) => {
  harness.group = props; return <div data-composer="public" />;
} }));
vi.mock("./ConversationDock", () => ({ ConversationDock: (props: NonNullable<typeof harness.dock>) => { harness.dock = props; return null; } }));
vi.mock("./ConversationHistorySheet", () => ({ ConversationHistorySheet: (props: NonNullable<typeof harness.sheet>) => { harness.sheet = props; return null; } }));
vi.mock("./ConversationTimeline", () => ({ ConversationTimeline: () => null }));
vi.mock("@/components/SelectionQuote", () => ({
  useSelectionQuote: (_host: unknown, options: unknown) => { harness.selectionOptions = options; return { selected: harness.selected, clear: vi.fn(), onMouseUp: vi.fn() }; },
  SelectionToolbar: (props: NonNullable<typeof harness.toolbar>) => { harness.toolbar = props; return null; },
}));
vi.mock("./ConversationAttachments", () => ({ AttachmentStatus: () => null }));
vi.mock("./ThreadMembersMenu", () => ({ ThreadMembersMenu: () => null }));
vi.mock("./TaskGroupTranscript", () => ({ TaskGroupTranscript: () => null }));
vi.mock("./MissionGroupTranscript", () => ({ MissionGroupTranscript: () => null }));
vi.mock("./Transcript", () => ({ ConversationNotice: () => null, ConversationThinking: () => null, ConversationTurns: () => null,
  ConversationStatusSlot: ({ children }: { children?: ReactNode }) => <>{children}</>, JumpToLatest: (props: (typeof harness.jumps)[number]) => { harness.jumps.push(props); return null; } }));
vi.mock("./useConversationScroll", () => ({ useConversationScroll: (args: unknown) => (harness.scrollArgs.push(args), { scrollRef: { current: null }, contentRef: { current: null }, atBottom: true, jumpToLatest: vi.fn() }) }));
// 这里的 window 是桩，HeroUI 的焦点监听在桩上跑不起来；只看历史状态的文字与重试键。
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children }: { children?: ReactNode }) => <button>{children}</button> }));

import { ConversationHost, type ConversationUiState } from "./ConversationHost";

beforeEach(() => {
  harness.states = []; harness.refs = []; harness.dependencies = [];
  harness.column.narrow = false; harness.column.mode = "expanded"; harness.conversation = {};
  harness.sheet = null; harness.dock = null; harness.jumps = []; harness.selected = null; harness.toolbar = null; harness.selectionOptions = null;
  harness.deskWidth = 600; harness.scrollArgs = [];
  vi.clearAllMocks();
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  vi.stubGlobal("window", { location: { search: "" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

function setup(page: ComponentProps<typeof ConversationHost>["page"] = { scope: "issue:issue-1", label: "灯塔续约",
  group: { kind: "thread", objectType: "issue", objectId: "issue-1", viewerId: "ceo", members: [] } }) {
  const ui: ConversationUiState = { keyboard: false, setKeyboard: vi.fn(), historyOpen: false, setHistoryOpen: vi.fn(),
    globalView: false, setGlobalView: vi.fn(), railMobileOpen: false, setRailMobileOpen: vi.fn(), prefill: null,
    consumePrefill: () => { ui.prefill = null; }, quotes: [], removeQuotes: vi.fn(), restoreQuotes: vi.fn(), quoteInConversation: vi.fn(),
    deskOpen: false, setDeskOpen: vi.fn((open: boolean) => { ui.deskOpen = open; }) };
  const props: ComponentProps<typeof ConversationHost> = { detailOpen: true, rail: true, agentTitle: "天枢", ui, page };
  const render = () => {
    let html = "";
    for (let pass = 0; pass < 6; pass++) {
      harness.stateIndex = 0; harness.refIndex = 0; harness.effectIndex = 0;
      harness.queued = []; harness.dirty = false; harness.rail = null; harness.agent = null; harness.group = null;
      html = renderToStaticMarkup(<ConversationHost {...props} />);
      harness.queued.forEach((effect) => effect());
      if (!harness.dirty) return html;
    }
    throw new Error("Conversation host did not settle");
  };
  return { ui, props, render };
}

describe("深度讨论的 ⤢ 键", () => {
  it("视口 <1280 不出 ⤢；≥1280、右列展开时才有", () => {
    const { render } = setup();
    harness.deskWidth = null; render();
    expect(harness.rail!.onDesk).toBeUndefined();
    harness.deskWidth = 600; render();
    expect(harness.rail!.onDesk).toBeTypeOf("function");
  });

  it("右列收起、窄屏浮层都不出 ⤢", () => {
    const { render } = setup();
    harness.column.mode = "strip"; render();
    expect(harness.rail!.onDesk).toBeUndefined();
    harness.column.mode = "expanded"; harness.column.narrow = true; render();
    expect(harness.rail!.onDesk).toBeUndefined();
  });

  it("按下去交给外壳；展开时右列拿到宿主算好的宽度", () => {
    const { ui, render } = setup();
    render(); harness.rail!.onDesk!(true);
    expect(ui.setDeskOpen).toHaveBeenCalledWith(true);
    render(); expect(harness.rail!.deskWidth).toBe(600);
    harness.deskWidth = 680; render();
    expect(harness.rail!.deskWidth).toBe(680);
    harness.rail!.onDesk!(false); render();
    expect(harness.rail!.deskWidth).toBeNull();
  });

  it("展开着变窄到 <1280：这一帧就收起，外壳那边也收起，变宽回来不自己再展开", () => {
    const { ui, render } = setup();
    ui.deskOpen = true; render();
    expect(harness.rail!.deskWidth).toBe(600);
    harness.deskWidth = null; render();
    expect(harness.rail!.deskWidth).toBeNull();
    expect(harness.rail!.onDesk).toBeUndefined();
    expect(ui.setDeskOpen).toHaveBeenLastCalledWith(false);
    harness.deskWidth = 600; render();
    expect(harness.rail!.deskWidth).toBeNull();
  });

  it("群聊也能展开；展开着切频道，深度讨论保持", () => {
    const { ui, render } = setup();
    ui.deskOpen = true; render();
    harness.rail!.onChannel("group"); render();
    expect(harness.rail!.channel).toBe("group");
    expect(harness.rail!.deskWidth).toBe(600);
    expect(harness.rail!.onDesk).toBeTypeOf("function");
  });

  it("战场页（对话挂在全局 scope 上）同样能展开", () => {
    const { ui, render } = setup({ scope: "global", label: "商业增长" });
    render(); expect(harness.rail!.onDesk).toBeTypeOf("function");
    ui.deskOpen = true; render();
    expect(harness.rail!.deskWidth).toBe(600);
  });
});

describe("深度讨论与正在进行的对话", () => {
  it("回答流式输出中展开 / 收起：不停止回答、不重置滚动（resetKey 不变）、频道不变", () => {
    const stop = vi.fn();
    harness.conversation = { streaming: true, stop };
    const { ui, render } = setup();
    render();
    const before = harness.scrollArgs.at(-1);
    ui.deskOpen = true; render();
    expect(harness.rail!.deskWidth).toBe(600);
    ui.deskOpen = false; render();
    expect(harness.scrollArgs.at(-1)).toEqual(before);
    expect(harness.scrollArgs.every((args) => (args as { resetKey: string }).resetKey === "agent")).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(harness.rail!.channel).toBe("agent");
  });

  it("展开着从左侧材料划词引用：进私聊输入条，深度讨论保持展开", () => {
    const { ui, render } = setup();
    ui.deskOpen = true; render();
    harness.rail!.onChannel("group"); render();
    ui.prefill = { text: "关于“续约率 92%”，", nonce: 7 };
    render();
    expect(harness.rail!.channel).toBe("agent");
    expect(harness.agent!.prefill?.text).toBe("关于“续约率 92%”，");
    expect(harness.rail!.deskWidth).toBe(600);
    expect(ui.setDeskOpen).not.toHaveBeenCalledWith(false);
  });
});

describe("战场页右栏（全局对话）是一条连续的对话", () => {
  it("页头没有「+」；空白对话里也没有「查看历史对话」", () => {
    const battlefield = setup({ scope: "global", label: "天枢" });
    harness.conversation = { messages: [{ sequence: 1, role: "user", content: "问" }] };
    battlefield.render();
    expect(harness.rail!.headerAction).toBeUndefined();
    harness.conversation = { messages: [] };
    expect(battlefield.render()).not.toContain("历史对话");
  });
});
