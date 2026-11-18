import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * 伙伴话里的会话名（本人 11/18）：真的 BuddyView → WorkTimeline → 气泡 / 卡片，和小条同名的那几个字带下划线，点了交给和小条同一个打开函数。
 * 桩同 buddyMainChain.test：这一轮的对话数据、同事来件、会议、交接、输入框和对话栏的壳。
 * 没有 jsdom：带 data-testid 的元素的 props 从 JSX 运行时截下来，直接调它们的处理器。
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
const convo = vi.hoisted(() => ({ cards: [] as unknown[], reply: "" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work/buddy" }));
vi.mock("@/conversation/useConversation", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/conversation/useConversation")>()), useConversation: () => ({
  scope: "global", status: "idle", streaming: false, thinking: false, partial: "", steps: [], stage: "answering", historyStatus: "ready", send: vi.fn(), rescope: vi.fn(), followLatest() {},
  messages: [{ sequence: 1, role: "user", content: "首页换个深色" }, { sequence: 2, role: "assistant", content: convo.reply, cards: convo.cards }],
}) }));
vi.mock("@/components/home/PartnerMeetings", () => ({ usePartnerMeetingFeed: () => ({ blocks: [], notice: null }) }));
vi.mock("@/components/meeting/MeetingWorkHandoffs", () => ({ useMeetingWorkHandoffFeed: () => ({ blocks: [], notice: null }), MeetingWorkFeedEntry: () => null }));
vi.mock("@/components/home/PartnerTeam", () => ({ usePartnerTeam: () => ({ blocks: [], composing: false, composer: null, launcher: null }) }));
vi.mock("@/components/home/view", () => ({ useViewChrome: () => ({ lead: null, trail: null }) }));
vi.mock("@/conversation/answerOptions", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/conversation/answerOptions")>()), useAnswerOptionFill: () => {} }));
vi.mock("@/components/home/InputBar", () => ({ InputBar: () => <div /> }));
vi.mock("@/components/rail/ChatPane", () => ({ ChatColumn: ({ head, timeline, data }: { head: ReactNode; timeline: (data: unknown) => ReactNode; data: unknown }) => <>{head}<main>{timeline(data)}</main></> }));

import type { SubSession } from "@/lib/home/types";
import type { Project } from "@/lib/home/projects";
import { BuddyView } from "@/components/home/Conversations";
import type { DispatchCard } from "@/components/home/DispatchChip";
import { SideDetailContext, type SideDetail } from "@/components/home/SideDetail";

const TOPIC = "00000000-0000-4000-8000-0000000000a1";
const SHORT = "00000000-0000-4000-8000-0000000000a2";
const PROJECT = "00000000-0000-4000-8000-000000000001";
const card = (extra: Partial<DispatchCard> = {}): DispatchCard => ({ kind: "buddy_dispatch", dispatchId: "00000000-0000-4000-8000-0000000000d1", projectId: PROJECT, projectName: "品牌建设",
  sub: { kind: "topic", id: TOPIC, title: "首页换深色" }, state: "active", ...extra });
const sub = (extra: Partial<SubSession> = {}) => ({ id: TOPIC, kind: "topic", letter: null, title: "首页深色方案", state: "running", unseen: false, waiting: null, queueReason: null, holdUntil: null,
  role: null, sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-18T01:00:00.000Z", merge: null, free: true, ...extra }) as unknown as SubSession;
const project = { id: PROJECT, name: "品牌建设", archived: false, unseen: false, subSessions: [] } as unknown as Project;
const side = () => ({ open: false, toggle: vi.fn(), node: null, shown: null, show: vi.fn(), wide: false, setWide: vi.fn(), openThread: vi.fn() }) as SideDetail & { openThread: ReturnType<typeof vi.fn> };
const render = ({ reply, cards = [card()], subs = [sub()], panel = side(), go = vi.fn() }: { reply: string; cards?: DispatchCard[]; subs?: SubSession[]; panel?: SideDetail | null; go?: (href: string) => void }) => {
  convo.cards = cards;
  convo.reply = reply;
  tap.props.clear();
  return renderToStaticMarkup(<SideDetailContext.Provider value={panel}>
    <BuddyView buddy={null} waiting={[]} outbox={[]} consume={() => {}} onSpeaking={() => {}} go={go} subs={subs} projects={[project]} waitingFolder={() => false} />
  </SideDetailContext.Provider>);
};
/** 画出来的会话名（带下划线的那几个字）：key 和字。 */
const named = (html: string) => [...html.matchAll(/<button type="button" data-thread="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => [match[1], match[2]!.replace(/<[^>]+>/g, "")]);
/** 在时间线上点一个会话名：点到的是那几个字里面（closest 找到带 data-thread 的那个）。 */
const clickName = (key: string) => (tap.props.get("thread-names")?.onClick as (event: unknown) => void)({
  target: { closest: (selector: string) => (selector === "[data-thread]" ? { getAttribute: (name: string) => (name === "data-thread" ? key : null) } : null) },
});
const clickChip = () => (tap.props.get("thread-chip")?.onClick as () => void)();

describe("伙伴话里的会话名（本人 11/18）", () => {
  it("这一轮结束后，伙伴话里和小条同名的那几个字有下划线，点了和点小条一样", () => {
    // 名字用会话现在的名字（卡上存的是开的时候的名字）。
    const panel = side();
    const go = vi.fn();
    const html = render({ reply: "我开了首页深色方案去做，做完告诉你。", panel, go });
    expect(named(html)).toEqual([[`topic:${TOPIC}`, "首页深色方案"]]);
    // 电脑上：点名字和点小条一样，都在右边开那个会话、页头带项目名。
    clickName(`topic:${TOPIC}`);
    clickChip();
    expect(panel.openThread).toHaveBeenCalledTimes(2);
    expect(panel.openThread.mock.calls[0]).toEqual([{ kind: "topic", id: TOPIC }, "品牌建设"]);
    expect(panel.openThread.mock.calls[0]).toEqual(panel.openThread.mock.calls[1]);
    expect(go).not.toHaveBeenCalled();
    // 点在名字以外的地方不开。
    (tap.props.get("thread-names")?.onClick as (event: unknown) => void)({ target: { closest: () => null } });
    expect(panel.openThread).toHaveBeenCalledTimes(2);
    // 手机上：都全屏打开那个会话。
    const phone = vi.fn();
    render({ reply: "我开了首页深色方案去做，做完告诉你。", panel: null, go: phone });
    clickName(`topic:${TOPIC}`);
    clickChip();
    expect(phone.mock.calls).toEqual([[`/me/work/topics/${TOPIC}`], [`/me/work/topics/${TOPIC}`]]);
  });

  it("代码块、行内代码、已有链接里的名字不加", () => {
    const html = render({ reply: "先看 `首页深色方案` 和 [首页深色方案](https://example.com/a)。\n\n```\n首页深色方案\n```\n\n最后：首页深色方案在跑。" });
    expect(named(html)).toEqual([[`topic:${TOPIC}`, "首页深色方案"]]);
    expect(html).toMatch(/最后：<button type="button" data-thread=/);
    expect(html).toMatch(/<code[^>]*>首页深色方案<\/code>/);
    expect(html).toMatch(/<a [^>]*>首页深色方案<\/a>/);
  });

  it("不足 4 个字的名字不加；同一个气泡里同一个名字只加第一处", () => {
    const short = card({ dispatchId: "00000000-0000-4000-8000-0000000000d2", sub: { kind: "topic", id: SHORT, title: "改首页" } });
    const html = render({ reply: "改首页先放着，首页深色方案在跑，首页深色方案做完再说。", cards: [card(), short], subs: [sub(), sub({ id: SHORT, title: "改首页" })] });
    expect(named(html)).toEqual([[`topic:${TOPIC}`, "首页深色方案"]]);
    expect(html).toContain("首页深色方案</button>在跑，首页深色方案做完再说。");
  });

  it("会话归档或删了以后不加", () => {
    const reply = "我开了首页深色方案去做，做完告诉你。";
    expect(named(render({ reply, cards: [card({ state: "archived" })] }))).toEqual([]);
    expect(named(render({ reply, cards: [card({ state: "gone", sub: { kind: "topic", id: null, title: "首页深色方案" } })] }))).toEqual([]);
    // 首页数据里已经没有这个会话了（删了）：也不加。
    expect(named(render({ reply, subs: [] }))).toEqual([]);
  });
});
