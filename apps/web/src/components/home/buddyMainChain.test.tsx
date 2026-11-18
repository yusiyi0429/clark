import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * 伙伴主线的整链（本人 11/18）：真的 BuddyView → WorkTimeline → DispatchChip → ThreadChip，点小条交给外壳的面板位（SideDetail.openThread）。
 * 只把要网络、要外壳的几样换成桩：这一轮的对话数据、同事来件、会议、交接、输入框和对话栏的壳。
 * 没有 jsdom：带 data-testid 的元素的 props 从 JSX 运行时截下来，直接调它们的处理器（同 threadChip.test）。
 */
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
const convo = vi.hoisted(() => ({ cards: [] as unknown[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work/buddy" }));
vi.mock("@/conversation/useConversation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/conversation/useConversation")>()), useConversation: () => ({
  scope: "global", status: "idle", streaming: false, thinking: false, partial: "", steps: [], stage: "answering", historyStatus: "ready", send: vi.fn(), rescope: vi.fn(), followLatest() {},
  messages: [{ sequence: 1, role: "user", content: "首页换个深色" }, { sequence: 2, role: "assistant", content: "开了一个会话去做。", cards: convo.cards }],
}) }));
vi.mock("./PartnerMeetings", () => ({ usePartnerMeetingFeed: () => ({ blocks: [], notice: null }) }));
vi.mock("../meeting/MeetingWorkHandoffs", () => ({ useMeetingWorkHandoffFeed: () => ({ blocks: [], notice: null }), MeetingWorkFeedEntry: () => null }));
vi.mock("./PartnerTeam", () => ({ usePartnerTeam: () => ({ blocks: [], composing: false, composer: null, launcher: null }) }));
vi.mock("./view", () => ({ useViewChrome: () => ({ lead: null, trail: null }) }));
vi.mock("@/conversation/answerOptions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/conversation/answerOptions")>()), useAnswerOptionFill: () => {} }));
vi.mock("./InputBar", () => ({ InputBar: () => <div /> }));
vi.mock("@/components/rail/ChatPane", () => ({ ChatColumn: ({ head, timeline, data }: { head: ReactNode; timeline: (data: unknown) => ReactNode; data: unknown }) => <>{head}<main>{timeline(data)}</main></> }));

import type { SubSession } from "@/lib/home/types";
import type { Project } from "@/lib/home/projects";
import { BuddyView } from "./Conversations";
import type { DispatchCard } from "./DispatchChip";
import { SideDetailContext, type SideDetail } from "./SideDetail";

const TOPIC = "00000000-0000-4000-8000-0000000000a1";
const PROJECT = "00000000-0000-4000-8000-000000000001";
const card: DispatchCard = { kind: "buddy_dispatch", dispatchId: "00000000-0000-4000-8000-0000000000d1", projectId: PROJECT, projectName: "品牌建设",
  sub: { kind: "topic", id: TOPIC, title: "首页换深色" }, state: "active" };
const live = { id: TOPIC, kind: "topic", letter: null, title: "首页换深色（改名后）", state: "running", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
  sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-18T01:00:00.000Z", merge: null, free: true } as unknown as SubSession;
const project = { id: PROJECT, name: "品牌建设", archived: false, unseen: false, subSessions: [] } as unknown as Project;
const side = () => ({ open: false, toggle: vi.fn(), node: null, shown: null, show: vi.fn(), wide: false, setWide: vi.fn(), openThread: vi.fn() }) as SideDetail & { openThread: ReturnType<typeof vi.fn> };
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const render = (panel: SideDetail | null, subs: SubSession[], go = vi.fn(), waitingFolder = (_: string) => false) => {
  convo.cards = [card];
  tap.props.clear();
  return renderToStaticMarkup(<SideDetailContext.Provider value={panel}>
    <BuddyView buddy={null} waiting={[]} outbox={[]} consume={() => {}} onSpeaking={() => {}} go={go} subs={subs} projects={[project]} waitingFolder={waitingFolder} />
  </SideDetailContext.Provider>);
};
const click = () => (tap.props.get("thread-chip")?.onClick as () => void)();

describe("伙伴主线：小条到右边（本人 11/18）", () => {
  it("刚开的会话还不在首页数据里，电脑上点小条也在右边开，数据到了就画出来", () => {
    // 首页数据里还没有它：照卡上存的名字画，点了照样交给右边的面板位（带上项目名），不离开主线。
    const panel = side();
    const go = vi.fn();
    const fresh = render(panel, [], go);
    expect(text(fresh)).toContain("|品牌建设 · |首页换深色|");
    click();
    expect(panel.openThread).toHaveBeenCalledWith({ kind: "topic", id: TOPIC }, "品牌建设");
    expect(go).not.toHaveBeenCalled();
    // 等项目绑文件夹：这时也写「等你」。
    expect(render(panel, [], go, (id) => id === PROJECT)).toMatch(/data-wait="">等你</);
    // 首页数据到了：小条换成那个会话本身（现名、状态）；右边面板照首页数据画（外壳在 threadSub 有了才出，见 leftCollapse.test）。
    const arrived = render(panel, [live], go);
    expect(text(arrived)).toContain("|品牌建设 · |首页换深色（改名后）|在跑|");
    click();
    expect(panel.openThread).toHaveBeenLastCalledWith({ kind: "topic", id: TOPIC }, "品牌建设");
    expect(go).not.toHaveBeenCalled();
  });

  it("手机上（没有右边的面板位）点小条全屏打开那个会话，刚开的也一样", () => {
    for (const subs of [[], [live]]) {
      const go = vi.fn();
      render(null, subs, go);
      click();
      expect(go).toHaveBeenCalledWith(`/me/work/topics/${TOPIC}`);
    }
  });
});
