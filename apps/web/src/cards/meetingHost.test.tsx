import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingCard } from "./MeetingCard";
import { meetingCard } from "./meetingWorkspace.test";

const viewer = vi.hoisted(() => ({ id: "none" }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], viewerId: viewer.id }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

describe("成员主持会议", () => {
  it("主持人能重新安排并上传文字记录，普通参会人保持只读", () => {
    const card = meetingCard({ hasEnded: true }, [{ actionId: "reschedule", actionType: "meeting.reschedule", label: "重新安排会议" }]);
    const render = () => renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly />);
    viewer.id = "p1";
    expect(render()).toContain("重新安排会议");
    expect(render()).toContain("选择会议记录文件");
    viewer.id = "someone-else";
    expect(render()).not.toContain("重新安排会议");
    expect(render()).not.toContain("选择会议记录文件");
  });
  it("这一版主持人和其他参会人都没有开始会议，双方都有材料下拉钮那一格", () => {
    const card = meetingCard({ purpose: "对齐预算" }, [{ actionId: "end", actionType: "meeting.end", label: "会议已结束" }]);
    const render = () => renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined}
      onNavigate={() => undefined} readOnly />);
    viewer.id = "p1";
    expect(render()).not.toContain("开始会议");
    expect(render()).toContain("data-header-tools");
    viewer.id = "someone-else";
    expect(render()).not.toContain("开始会议");
    expect(render()).toContain("data-header-tools");
  });
});
