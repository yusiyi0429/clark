import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ConversationData } from "./useConversation";

const harness = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  rail: null as { channel: string; onChannel: (channel: string) => void } | null,
  agent: null as { prefill: { text: string; nonce: number } | null; onPrefillUsed: () => void; data: ConversationData; onRestoreQuotes?: unknown } | null,
  group: null as { onSend: (body: string) => unknown } | null,
  privateSend: vi.fn().mockResolvedValue(true), groupSend: vi.fn().mockResolvedValue(true),
  column: { mode: "strip" as "strip" | "expanded", narrow: false, setMode: vi.fn() },
  conversation: {} as Record<string, unknown>,
  anchor: undefined as { cardId: string; version: number } | undefined,
  sheet: null as { onQuote?: (text: string) => void; onClose: () => void; composerRef?: unknown; notice?: string | null } | null,
  dock: null as { dockRef?: unknown; onRestoreQuotes?: unknown; keyboard: boolean; onKeyboardChange: (keyboard: boolean) => void;
    onDictationError?: (error: string | null) => void; wide?: boolean; onWideExit?: () => void } | null,
  viewport: 1440,
  jumps: [] as { streaming?: boolean; visible: boolean }[],
  selected: null as { top: number; left: number; text: string } | null,
  toolbar: null as { label?: string; onQuote: () => void } | null,
  selectionOptions: null as unknown,
  buddy: null as { name: string; form: "classic" | "alive" | "panda" } | null,
  listening: false,
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
vi.mock("./useConversation", () => ({ CONVERSATION_SEND: "conversation-send", useConversation: (scope: string, _material: unknown, _context: unknown,
  anchor: { cardId: string; version: number } | undefined) => { harness.anchor = anchor; return { scope, messages: [], streaming: false,
  attachments: [], error: null, historyStatus: "ready", historyError: null, retryHistory: vi.fn(), send: harness.privateSend, ...harness.conversation }; } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./useMissionGroup", () => ({ useMissionGroup: () => ({ view: { members: [], entries: [] }, send: harness.groupSend }) }));
vi.mock("./useTaskGroup", () => ({ useThreadGroup: () => ({ view: { members: [], messages: [] }, catchUp: null }) }));
vi.mock("./desk/useDeskLayout", async (importOriginal) => ({ ...(await importOriginal<typeof import("./desk/useDeskLayout")>()), useViewportWidth: () => harness.viewport }));
vi.mock("./useColumnMode", () => ({ useColumnMode: () => harness.column }));
vi.mock("./references", () => ({ useReferences: () => null }));
vi.mock("@/components/coagent/presence", () => ({ useListening: () => harness.listening }));
vi.mock("@/components/buddy/useBuddy", () => ({ useBuddy: () => ({ buddy: harness.buddy, loading: false }) }));
vi.mock("@/components/coagent/PresenceCapsule", () => ({ PresenceCapsule: () => null }));
vi.mock("./ConversationColumn", () => ({ conversationStyles: {}, ConversationColumn: (props: NonNullable<typeof harness.rail> & { children: ReactNode }) => {
  harness.rail = props; return <aside data-channel={props.channel}>{props.children}</aside>;
} }));
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
vi.mock("./useConversationScroll", () => ({ useConversationScroll: () => ({ scrollRef: { current: null }, contentRef: { current: null }, atBottom: true, jumpToLatest: vi.fn() }) }));
// 这里的 window 是桩，HeroUI 的焦点监听在桩上跑不起来；只看历史状态的文字与重试键。
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children }: { children?: ReactNode }) => <button>{children}</button> }));

import { ConversationHost, type ConversationUiState } from "./ConversationHost";

beforeEach(() => {
  harness.states = []; harness.refs = []; harness.dependencies = [];
  harness.column.narrow = false; harness.column.mode = "strip"; harness.conversation = {}; harness.anchor = undefined;
  harness.viewport = 1440; harness.sheet = null; harness.dock = null; harness.jumps = []; harness.selected = null; harness.toolbar = null; harness.selectionOptions = null;
  harness.buddy = null; harness.listening = false;
  vi.clearAllMocks();
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  vi.stubGlobal("window", { location: { search: "" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const ui: ConversationUiState = { keyboard: false, setKeyboard: vi.fn(), historyOpen: false, setHistoryOpen: vi.fn(),
    globalView: false, setGlobalView: vi.fn(), railMobileOpen: false, setRailMobileOpen: vi.fn(), prefill: null,
    consumePrefill: () => { ui.prefill = null; }, quotes: [], removeQuotes: vi.fn(), restoreQuotes: vi.fn(), quoteInConversation: vi.fn() };
  const props: ComponentProps<typeof ConversationHost> = { detailOpen: true, rail: true, agentTitle: "Co-Agent", ui,
    page: { scope: "mission-card:card-01", label: "孙铭泽 · 10月任务", group: {
      cardId: "card-01", viewerId: "sun", members: [], phase: "open", round: 1, onRefresh: vi.fn(), onRemoveReference: vi.fn(),
    } } };
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

describe("任务卡引用进入私聊", () => {
  it("本页对应这条对话的卡作为 Anchor（cardId + version）发出，改看全局对话时不带", () => {
    const { props, ui, render } = setup();
    props.page!.cards = [{ id: "issue:other", version: 2, conversation: { scope: "issue:other" } },
      { id: "mission-card:card-01", version: 4, conversation: { scope: "mission-card:card-01" } }] as NonNullable<typeof props.page>["cards"];
    render();
    expect(harness.anchor).toEqual({ cardId: "mission-card:card-01", version: 4 });
    ui.globalView = true; render();
    expect(harness.anchor).toBeUndefined();
  });

  it("页面登记的 anchor（战场页，scope 仍是 global）优先于按 scope 找卡", () => {
    const { props, render } = setup();
    props.page = { scope: "global", label: "增长战场", cards: [{ id: "issue:1", version: 1, conversation: { scope: "issue:1" } }],
      anchor: { id: "battlefield:growth", version: 7 } } as NonNullable<typeof props.page>;
    render();
    expect(harness.anchor).toEqual({ cardId: "battlefield:growth", version: 7 });
  });

  it.each([false, true])("从公开事项群组引用并对话，切回 Co-Agent 且不公开发送（窄屏：%s）", async (narrow) => {
    harness.column.narrow = narrow;
    const { ui, render } = setup();
    render(); harness.rail!.onChannel("group");
    expect(render()).toContain('data-composer="public"');
    ui.prefill = { text: "关于“界面与权限证据”，", nonce: 1 };
    const html = render();
    expect(harness.rail!.channel).toBe("agent");
    expect(html).toContain('data-composer="private"');
    expect(harness.agent!.prefill?.text).toBe(ui.prefill.text);
    expect(harness.privateSend).not.toHaveBeenCalled();
    expect(harness.groupSend).not.toHaveBeenCalled();
    if (narrow) expect(ui.setRailMobileOpen).toHaveBeenCalledWith(true);
    else expect(harness.column.setMode).toHaveBeenCalledWith("expanded");
    await harness.agent!.data.send(`${ui.prefill.text}改成包含走查记录`, []);
    expect(harness.privateSend).toHaveBeenCalledOnce();
    expect(harness.groupSend).not.toHaveBeenCalled();
    harness.agent!.onPrefillUsed(); render();
    expect(harness.rail!.channel).toBe("agent");
    // 引用消费后，用户仍可主动回公开频道，普通重绘不能再抢回私聊。
    harness.rail!.onChannel("group"); render();
    expect(harness.rail!.channel).toBe("group");
  });

  it.each([false, true])("通知深链首次展开群组，引用后的双向宽度变化保留当前私聊（初始窄屏：%s）", (narrow) => {
    harness.column.narrow = narrow;
    window.location.search = "?channel=group";
    const { ui, render } = setup();
    render(); expect(harness.rail!.channel).toBe("group");
    if (narrow) expect(ui.setRailMobileOpen).toHaveBeenCalledWith(true);
    else expect(harness.column.setMode).toHaveBeenCalledWith("expanded");
    ui.prefill = { text: "关于“本月任务”，", nonce: 2 };
    render(); expect(harness.rail!.channel).toBe("agent");
    expect(harness.agent!.data.scope).toBe("mission-card:card-01");
    harness.agent!.onPrefillUsed(); render();
    vi.mocked(ui.setRailMobileOpen).mockClear(); harness.column.setMode.mockClear();
    harness.column.narrow = !narrow; render();
    expect(harness.rail!.channel).toBe("agent");
    harness.column.narrow = narrow; render();
    expect(harness.rail!.channel).toBe("agent");
    expect(ui.setRailMobileOpen).not.toHaveBeenCalled();
    expect(harness.column.setMode).not.toHaveBeenCalled();
    expect(harness.groupSend).not.toHaveBeenCalled();
  });

  it("群组深链水合后才识别窄屏时，仍展开群聊浮层", () => {
    window.location.search = "?channel=group";
    const { ui, render } = setup();
    render(); expect(harness.rail!.channel).toBe("group");
    harness.column.narrow = true; render();
    expect(harness.rail!.channel).toBe("group");
    expect(ui.setRailMobileOpen).toHaveBeenCalledWith(true);
    expect(harness.privateSend).not.toHaveBeenCalled();
    expect(harness.groupSend).not.toHaveBeenCalled();
  });

  it("本人准备阶段不提供公开群组，旧群组深链和残留频道选择都留在私聊", () => {
    window.location.search = "?channel=group";
    const { props, render } = setup();
    Object.assign(props.page!.group!, { canDiscuss: false });
    expect(render()).toContain('data-composer="private"');
    expect(harness.rail!.channel).toBe("agent");
    harness.rail!.onChannel("group");
    expect(render()).toContain('data-composer="private"');
    expect(harness.rail!.channel).toBe("agent");
    expect(harness.groupSend).not.toHaveBeenCalled();
  });
});

describe("右列私聊的历史状态与记录归属", () => {
  it("载入中、没读到、真的没有三种画法不同；没读到不显示「暂无消息」", () => {
    const { render } = setup();
    harness.conversation = { historyStatus: "loading" };
    let html = render();
    expect(html).toContain("正在载入对话记录…");
    expect(html).not.toContain("暂无消息");
    harness.conversation = { historyStatus: "error", historyError: null };
    html = render();
    expect(html).toContain("对话记录暂未载入");
    expect(html).toContain("重试");
    expect(html).not.toContain("暂无消息");
    harness.conversation = { historyStatus: "ready" };
    html = render();
    expect(html).toContain("暂无消息");
    expect(html).not.toContain("重试");
  });

  it("页脚只标谁看得到：私聊「仅你可见」，群组「成员可见」，不写说明", () => {
    const { render } = setup();
    expect(render()).toContain(">仅你可见<");
    expect(render()).not.toContain("只读：不修改左侧内容");
    expect(render()).toContain('data-conversation-owner="object"');
    harness.rail!.onChannel("group");
    const group = render();
    expect(group).toContain(">成员可见<");
    expect(group).toContain('data-conversation-owner="group"');
    expect(group).not.toContain("仅你可见");
  });

  it("挂在全局 scope 上的二级页（如复盘总览），右列标成全局对话（data-conversation-owner），页脚同样只写「仅你可见」", () => {
    const { props, render } = setup();
    props.page = { scope: "global", label: "10 月复盘 · LTO 审视" };
    const html = render();
    expect(html).toContain(">仅你可见<");
    expect(html).toContain('data-conversation-owner="global"');
  });
});

describe("对话正文划词引用（B4）", () => {
  it("右列私聊：选中正文浮出「回复」，回复进这条右列对话（当前对象 scope），不切到别处", () => {
    const { ui, render } = setup();
    harness.selected = { top: 0, left: 0, text: "灯塔已签约" };
    render();
    expect(harness.selectionOptions).toEqual({ within: "[data-chat-role]" });
    expect(harness.toolbar?.label).toBe("回复");
    harness.toolbar!.onQuote();
    expect(ui.quoteInConversation).toHaveBeenCalledWith("灯塔已签约", { scope: "mission-card:card-01", intent: "message-reply" });
    expect(ui.setHistoryOpen).not.toHaveBeenCalled();
    expect(ui.setGlobalView).not.toHaveBeenCalled();
  });

  it("右列切到群聊时不浮出引用（引用只进私聊）", () => {
    const { render } = setup();
    harness.selected = { top: 0, left: 0, text: "群里的话" };
    render(); harness.rail!.onChannel("group");
    harness.toolbar = null; render();
    expect(harness.toolbar).toBeNull();
  });

  it("对话层（全局对话）：引用归属这条对话，对话层保持打开", () => {
    const { ui, props, render } = setup();
    props.page = null; props.detailOpen = false; props.rail = false; ui.historyOpen = true;
    render();
    harness.sheet!.onQuote!("先保灯塔交付");
    expect(ui.quoteInConversation).toHaveBeenCalledWith("先保灯塔交付", { scope: "global", intent: "message-reply" });
    expect(ui.setHistoryOpen).not.toHaveBeenCalled();
    expect(ui.setGlobalView).not.toHaveBeenCalled();
  });
});

describe("全局对话第三轮（D3 / D5）", () => {
  it("右列：Agent 输出中 ↓ 球里是「正在输出」；切到群聊不显示", () => {
    harness.conversation = { streaming: true };
    const { render } = setup();
    harness.jumps = []; render();
    expect(harness.jumps.at(-1)?.streaming).toBe(true);
    harness.rail!.onChannel("group");
    harness.jumps = []; render();
    expect(harness.jumps.at(-1)?.streaming).toBe(false);
  });

  it("全局对话层：对话层拿到的是输入条那一块的引用（↓ 按它的上沿定位）；发送失败的引用交回 ui.restoreQuotes", () => {
    const { ui, props, render } = setup();
    props.page = null; props.detailOpen = false; props.rail = false; ui.historyOpen = true;
    render();
    expect(harness.sheet!.composerRef).toBeTruthy();
    expect(harness.sheet!.composerRef).toBe(harness.dock!.dockRef);
    expect(harness.dock!.onRestoreQuotes).toBe(ui.restoreQuotes);
  });

  it("右列输入条：发送失败的引用同样交回 ui.restoreQuotes", () => {
    const { ui, render } = setup();
    render();
    expect(harness.agent!.onRestoreQuotes).toBe(ui.restoreQuotes);
  });
});

describe("打字面与对话层一起开合（D6）", () => {
  function home() {
    const context = setup();
    context.props.page = null; context.props.detailOpen = false; context.props.rail = false;
    return context;
  }

  it("从收起的输入条进入打字（「对话天枢」）就升起对话层", () => {
    const { ui, render } = home();
    render();
    expect(harness.dock!.keyboard).toBe(false);
    expect(harness.sheet).toBeNull();
    harness.dock!.onKeyboardChange(true);
    expect(ui.setKeyboard).toHaveBeenCalledWith(true);
    expect(ui.setHistoryOpen).toHaveBeenCalledWith(true);
  });

  it("对话层开着时输入条就是打字面；收起（⌄ / 点空白 / 输入框里 Esc）输入条一起回到胶囊", () => {
    const { ui, render } = home();
    ui.historyOpen = true;
    render();
    expect(harness.dock!.keyboard).toBe(true);
    harness.sheet!.onClose();
    expect(ui.setHistoryOpen).toHaveBeenCalledWith(false);
    expect(ui.setKeyboard).toHaveBeenCalledWith(false);
    vi.clearAllMocks();
    harness.dock!.onKeyboardChange(false);
    expect(ui.setHistoryOpen).toHaveBeenCalledWith(false);
    expect(ui.setKeyboard).toHaveBeenCalledWith(false);
  });

  it("外壳用 Esc 收起对话层（只改 historyOpen）时，输入条同样回到胶囊", () => {
    const { ui, render } = home();
    ui.historyOpen = true; render();
    ui.historyOpen = false; ui.keyboard = true; render();
    expect(harness.dock!.keyboard).toBe(false);
  });

  it("对话层放大着：输入条拿到 wide 和退出放大的回调，退出只改放大、不收对话层；<1280 不算放大", () => {
    const { ui, render } = home();
    ui.historyOpen = true; ui.sheetWide = true; ui.setSheetWide = vi.fn();
    render();
    expect(harness.dock!.wide).toBe(true);
    harness.dock!.onWideExit!();
    expect(ui.setSheetWide).toHaveBeenCalledWith(false);
    expect(ui.setHistoryOpen).not.toHaveBeenCalled();
    expect(ui.setKeyboard).not.toHaveBeenCalled();
    harness.viewport = 1100;
    render();
    expect(harness.dock!.wide).toBe(false);
  });

  it("没有右列的页面上来了新引用 / 起草：对话层一起升起；有右列时进右列，不开对话层", () => {
    const { ui, render } = home();
    ui.prefill = { text: "先保灯塔交付", nonce: 7 };
    render();
    expect(ui.setHistoryOpen).toHaveBeenCalledWith(true);
    vi.clearAllMocks();
    const rail = setup();
    rail.ui.prefill = { text: "关于“界面与权限证据”，", nonce: 8 };
    rail.render();
    expect(rail.ui.setHistoryOpen).not.toHaveBeenCalled();
  });

  it("听写出错的提示交给对话层显示", () => {
    const { ui, render } = home();
    ui.historyOpen = true; render();
    expect(harness.sheet!.notice ?? null).toBeNull();
    harness.dock!.onDictationError!("未识别到语音，请靠近麦克风后重试。");
    render();
    expect(harness.sheet!.notice).toBe("未识别到语音，请靠近麦克风后重试。");
  });
});

describe("议题群聊（巡检 P0-3）", () => {
  it("议题页拉人后右列出现「议题群聊」频道", () => {
    const { props, render } = setup();
    props.page = { scope: "issue:i-1", label: "议题", group: { kind: "thread", objectType: "issue", objectId: "i-1", viewerId: "ceo", members: [] } };
    render();
    const channels = (harness.rail as unknown as { channels: { id: string; label: string }[] }).channels;
    expect(channels.map((channel) => channel.id)).toEqual(["agent", "group"]);
    expect(channels[1].label).toContain("议题群聊");
  });
});

describe("伙伴露脸（spec 5.5）", () => {
  it("有伙伴时私聊标题是伙伴的名字，录音时右列胶囊是本人选的样子；没有伙伴时照旧", () => {
    const { render } = setup();
    harness.listening = true;
    render();
    const rail = () => harness.rail as unknown as { channels: { id: string; title?: string }[]; coagent?: { props: { skin: string } } };
    expect(rail().channels[0].title).toBe("Co-Agent");
    expect(rail().coagent?.props.skin).toBe("classic");
    harness.buddy = { name: "团团", form: "panda" };
    render();
    expect(rail().channels[0].title).toBe("团团");
    expect(rail().coagent?.props.skin).toBe("panda");
  });

  it("首页输入条收起时的主按钮也用伙伴的名字；没有伙伴时不传", () => {
    const { props, render } = setup();
    props.rail = false;
    render();
    expect((harness.dock as unknown as { agentName?: string }).agentName).toBeUndefined();
    harness.buddy = { name: "团团", form: "classic" };
    render();
    expect((harness.dock as unknown as { agentName?: string }).agentName).toBe("团团");
  });
});
