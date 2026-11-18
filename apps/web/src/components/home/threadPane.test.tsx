import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TTaskCard, TTaskView } from "@warmap/contracts";

/** 没有 jsdom：带 data-testid 的元素的 props 从 JSX 运行时截下来，直接调它们的处理器（同 sessionsPanel.test）。 */
const tap = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>>() }));
const capture = vi.hoisted(() => <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
  if (typeof props?.["data-testid"] === "string") tap.props.set(props["data-testid"] as string, props);
  return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
}) as unknown as T);
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: capture(actual.jsxDEV) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));
const { CARD, OUTPUT } = vi.hoisted(() => ({ CARD: "00000000-0000-4000-8000-0000000000c1", OUTPUT: "00000000-0000-4000-8000-0000000000b1" }));
vi.mock("@/components/cards/useCardDetail", () => {
  const task = {
    id: CARD, version: 1, title: "首页手机检查", status: "in_progress", source: "self", startDate: null, dueDate: null, doneDefinition: "做完", mission: null, waitingOn: null,
    owner: { personId: "p1", name: "孙铭泽" }, collaborators: [], latestProgress: null, returnReason: null, origin: null, awaitingAcceptance: false, planTaskId: null, blocker: null,
    createdAt: "2026-11-17T01:00:00Z", updatedAt: "2026-11-17T01:00:00Z",
    card: { stage: "doing", wait: null, executor: "claude_code", role: null, model: null, criterion: null, run: null, handback: null, deliverable: null, after: [], sourceWords: [] } as TTaskCard,
  } as unknown as TTaskView;
  const detail = { task, letter: null, brief: "在手机上过一遍首页", standards: ["375 宽不截断"], runs: [], handbacks: [], fallback: false,
    outputs: [{ id: OUTPUT, kind: "artifact", title: "检查记录", fileName: "check.md", url: null }] };
  return { useCardDetail: () => ({ detail, missing: false, refresh: async () => undefined }) };
});

// 专题会话只看 ThreadPane 交给它什么（钉在输入框上方的那个框）；读专题要网络，这里不读。
vi.mock("@/components/topics/TopicSession", () => ({
  TopicSession: ({ ask, pane }: { ask?: ReactNode; pane?: boolean }) => <div data-testid="topic-session" data-pane={pane ? "" : undefined}>{ask}</div>,
}));

import type { ReactNode } from "react";
import type { SubSession } from "@/lib/home/types";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import { SideDetailContext, type SideDetail } from "./SideDetail";
import { ThreadPane } from "./ThreadPane";
import { ViewChrome } from "./view";

const sub = { id: CARD, kind: "card", letter: null, title: "首页手机检查", state: "running", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
  sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-17T01:00:00.000Z", merge: null } as unknown as SubSession;
const local = { runner: createMockRunner(), phase: "offline", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null, sources: null,
  refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as LocalRunnerState;
const outer = () => ({ open: false, toggle: vi.fn(), node: null, shown: "thread", show: vi.fn(), wide: false, setWide: vi.fn(), openThread: vi.fn() }) as SideDetail & { show: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> };
const render = (side: SideDetail, go = vi.fn(), onClose = vi.fn(), extra: { sub?: SubSession; from?: string | null; ask?: ReactNode; local?: LocalRunnerState } = {}) => renderToStaticMarkup(
  <LocalContext.Provider value={extra.local ?? local}>
    <SideDetailContext.Provider value={side}>
      <ViewChrome.Provider value={{ lead: <i>返回键</i>, trail: <i>会话按钮</i>, parent: <i>天枢新版 / </i> }}>
        <ThreadPane sub={extra.sub ?? sub} go={go} onClose={onClose} from={extra.from} ask={extra.ask} />
      </ViewChrome.Provider>
    </SideDetailContext.Provider>
  </LocalContext.Provider>,
);

describe("右边的 thread 视图（设计 6.6）", () => {
  it("窄面板里不换掉自己：详情、文件就地开", () => {
    const side = outer();
    const html = render(side);
    // 标题是子会话名；里面是子会话的窄面板模式：单列，不画外面页头的返回、会话按钮、上一级。
    expect(html).toContain('data-testid="side-thread"');
    expect(html).toContain("首页手机检查");
    expect(html).toMatch(/data-testid="card-session"[^>]*data-pane=""|data-pane=""[^>]*data-testid="card-session"/);
    expect(html).toMatch(/data-solo=""/);
    expect(html).not.toContain("返回键");
    expect(html).not.toContain("会话按钮");
    expect(html).not.toContain("天枢新版 / ");
    // 不在这台电脑上：先看详情，就地画在面板里（不是挂进外面的面板位）。
    expect(html).toContain('aria-label="结果"');
    // 点详情、点产出：都不去动外面的面板位（不会把自己换掉）。
    (tap.props.get("session-details")?.onPress as () => void)();
    (tap.props.get("output-open")?.onClick as () => void)();
    expect(side.show).not.toHaveBeenCalled();
    expect(side.toggle).not.toHaveBeenCalled();
  });

  it("从主线开的：会话名下面一行淡字「项目名 · 从主线开的」；没给就不写", () => {
    const html = render(outer(), vi.fn(), vi.fn(), { from: "品牌建设" });
    expect(html).toMatch(/data-testid="thread-from"[^>]*>品牌建设 · 从主线开的</);
    expect(html.indexOf("首页手机检查")).toBeLessThan(html.indexOf("从主线开的"));
    expect(render(outer())).not.toContain("从主线开的");
  });

  it("等文件夹的会话：右边就地问「在哪个文件夹开工？」", () => {
    const topic = { ...sub, id: "00000000-0000-4000-8000-0000000000a1", kind: "topic", free: true } as unknown as SubSession;
    const html = render(outer(), vi.fn(), vi.fn(), { sub: topic, ask: <div data-testid="folder-ask">在哪个文件夹开工？</div> });
    expect(html).toContain('data-testid="folder-ask"');
    expect(html).toContain("在哪个文件夹开工？");
  });

  it("等你回答的事件行在右边开，提问框在右边就能答", async () => {
    // 主线事件行（带 waitingId 的提问）在右边开的是这个子会话：首页数据说它在问你，这台电脑上就有那个会话、正挂着这个问题。
    const runner = createMockRunner();
    const answer = vi.spyOn(runner, "answerQuestion").mockResolvedValue(undefined as never);
    const session = { permissionMode: "auto", id: "00000000-0000-4000-8000-0000000000e1", subject: { kind: "card", cardId: CARD }, title: "首页手机检查", agent: "claude-code",
      modelProfileId: "subscription", modelLabel: "Sonnet", cwd: "C:/w", status: "idle", includePersonalConfig: false, createdAt: "2026-11-17T01:00:00Z", updatedAt: "2026-11-17T01:10:00Z",
      lastSeq: 3, pendingPermissions: 0, queuePosition: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
      pendingQuestion: { requestId: "q1", askedAt: "2026-11-17T01:09:00Z", questions: [{ question: "字体用哪个？", header: "", multiSelect: false, options: [{ label: "思源黑体", description: "" }, { label: "系统字体", description: "" }] }] } };
    const here = { ...local, runner, phase: "ready", sessions: [session] } as unknown as LocalRunnerState;
    const html = render(outer(), vi.fn(), vi.fn(), { sub: { ...sub, waiting: "question" } as unknown as SubSession, local: here });
    // 提问框钉在右边那个会话的输入框上方，能点（不是「等你 · 别的电脑」那种只读）。
    expect(html).toMatch(/data-testid="question-decision"/);
    expect(html).toContain("字体用哪个？");
    expect(html).not.toMatch(/data-blocked=""[^>]*data-testid="question-decision"/);
    // 当场答：选一项，就交给这台电脑上的那个会话。
    (tap.props.get("decision-option")?.onClick as () => void)();
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith(session.id, "q1", expect.objectContaining({ choices: [[expect.any(String)]] })));
  });

  it("放大去中间", () => {
    const go = vi.fn();
    const onClose = vi.fn();
    const html = render(outer(), go, onClose);
    expect(html).toMatch(/aria-label="放大"/);
    (tap.props.get("thread-wide")?.onPress as () => void)();
    expect(go).toHaveBeenCalledWith(`/me/work/cards/${CARD}`);
    expect(onClose).toHaveBeenCalled();
    (tap.props.get("thread-close")?.onPress as () => void)();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
