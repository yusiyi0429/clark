import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const feed = vi.hoisted(() => ({ meetings: vi.fn(), handoffs: vi.fn() }));
vi.mock("./PartnerMeetings", () => ({ usePartnerMeetingFeed: feed.meetings }));
vi.mock("../meeting/MeetingWorkHandoffs", () => ({ useMeetingWorkHandoffFeed: feed.handoffs, MeetingWorkFeedEntry: () => null }));
vi.mock("./PartnerTeam", () => ({ usePartnerTeam: () => ({ blocks: [{ key: "team:a", at: "2026-11-15T00:00:00Z", node: <p>同事来件</p> }], composing: false, composer: null, launcher: null }) }));
vi.mock("./PartnerWorkEvents", () => ({ usePartnerWorkEvents: () => [{ key: "work:a", at: "2026-11-15T00:02:00Z", node: <p>工作进展</p> }] }));
vi.mock("@/conversation/useConversation", () => ({ useConversation: () => ({ scope: "global", status: "idle", streaming: false, partial: "", steps: [], followLatest() {} }) }));
vi.mock("./view", () => ({ useViewChrome: () => ({ lead: null, trail: null }) }));
vi.mock("@/conversation/answerOptions", () => ({ useAnswerOptionFill: () => {} }));
vi.mock("./InputBar", () => ({ InputBar: ({ dock }: { dock?: ReactNode }) => <div data-testid="measured-input">{dock}</div> }));
vi.mock("@/components/work/WorkTimeline", () => ({ WorkTimeline: ({ blocks }: { blocks: { key: string; node: ReactNode }[] }) => <div data-testid="unified-timeline">{blocks.map(block => <section key={block.key} data-block={block.key}>{block.node}</section>)}</div> }));
vi.mock("@/components/rail/ChatPane", () => ({ ChatColumn: ({ head, timeline, dock, input, data }: {
  head: ReactNode; timeline: (data: unknown) => ReactNode; dock: (latest: unknown) => ReactNode; input: (height: () => void) => ReactNode; data: unknown;
}) => <>{head}<main>{timeline(data)}</main>{dock({ visible: false, jump() {} })}{input(() => {})}</> }));

import { BuddyView } from "./Conversations";

describe("伙伴工作间集成", () => {
  it("会议与交接接入唯一时间线；页头左边是名字、正中是伙伴（11/17 设计 4.2），没有预约条和子会话汇总；输入框上方没有待发条，发出的话直接进对话", () => {
    feed.meetings.mockReturnValue({ blocks: [{ key: "meeting:a", at: "2026-11-15T00:01:00Z", node: <p>已结束会议</p> }], notice: <p>会议读取提示</p>, scheduled: <details><summary>会议安排</summary>明天</details> });
    feed.handoffs.mockReturnValue({ blocks: [{ key: "handoff:a", at: "2026-11-15T00:03:00Z", node: <p>已确认交接</p> }], notice: null });
    const html = renderToStaticMarkup(<BuddyView buddy={null} waiting={[]} outbox={[]} consume={() => {}} onSpeaking={() => {}} go={() => {}} subs={[]} projects={[]} waitingFolder={() => false} />);
    for (const key of ["team:a", "work:a", "meeting:a", "handoff:a"]) expect(html).toContain(`data-block="${key}"`);
    expect(html.match(/data-testid="unified-timeline"/g)).toHaveLength(1);
    expect(html).not.toContain("会议安排");
    const head = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(head).toMatch(/<h1[^>]*>伙伴<\/h1><\/div><div[^>]*data-presence=""[^>]*><span[^>]*data-place="head"/);
    expect(head).not.toContain("presence-pill");
    expect(html).toContain('<div data-testid="measured-input"></div>');
    expect(html).not.toContain("待发需求");
    expect(feed.meetings).toHaveBeenCalledTimes(1);
    expect(feed.handoffs).toHaveBeenCalledTimes(1);
  });
});
