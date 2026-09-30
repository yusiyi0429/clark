import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ConversationData } from "./useConversation";

const harness = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  rail: null as { channel: string; onChannel: (channel: string) => void } | null,
  agent: null as { prefill: { text: string; nonce: number } | null; onPrefillUsed: () => void; data: ConversationData } | null,
  group: null as { onSend: (body: string) => unknown } | null,
  privateSend: vi.fn().mockResolvedValue(true), groupSend: vi.fn().mockResolvedValue(true),
  column: { mode: "strip" as "strip" | "expanded", narrow: false, setMode: vi.fn() },
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
  attachments: [], error: null, send: harness.privateSend }) }));
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
vi.mock("./ColumnComposer", () => ({ ColumnComposer: (props: NonNullable<typeof harness.agent>) => {
  harness.agent = props; return <div data-composer="private">{props.prefill?.text}</div>;
} }));
vi.mock("./MissionGroupComposer", () => ({ MissionGroupComposer: (props: NonNullable<typeof harness.group>) => {
  harness.group = props; return <div data-composer="public" />;
} }));
vi.mock("./ConversationDock", () => ({ ConversationDock: () => null }));
vi.mock("./ConversationHistorySheet", () => ({ ConversationHistorySheet: () => null }));
vi.mock("./ConversationAttachments", () => ({ AttachmentStatus: () => null }));
vi.mock("./ThreadMembersMenu", () => ({ ThreadMembersMenu: () => null }));
vi.mock("./TaskGroupTranscript", () => ({ TaskGroupTranscript: () => null }));
vi.mock("./MissionGroupTranscript", () => ({ MissionGroupTranscript: () => null }));
vi.mock("./Transcript", () => ({ ConversationNotice: () => null, ConversationThinking: () => null, ConversationTurns: () => null }));

import { ConversationHost, type ConversationUiState } from "./ConversationHost";

beforeEach(() => {
  harness.states = []; harness.refs = []; harness.dependencies = [];
  harness.column.narrow = false; harness.column.mode = "strip";
  vi.clearAllMocks();
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  vi.stubGlobal("window", { location: { search: "" }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const ui: ConversationUiState = { keyboard: false, setKeyboard: vi.fn(), historyOpen: false, setHistoryOpen: vi.fn(),
    globalView: false, setGlobalView: vi.fn(), railMobileOpen: false, setRailMobileOpen: vi.fn(), prefill: null,
    consumePrefill: () => { ui.prefill = null; }, quotes: [], removeQuotes: vi.fn() };
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
    Object.assign(props.page!.group!, { canDiscuss: false, agentNote: "仅你可见 · 确认前可修改正文" });
    expect(render()).toContain('data-composer="private"');
    expect(harness.rail!.channel).toBe("agent");
    harness.rail!.onChannel("group");
    expect(render()).toContain('data-composer="private"');
    expect(harness.rail!.channel).toBe("agent");
    expect(harness.groupSend).not.toHaveBeenCalled();
  });
});
