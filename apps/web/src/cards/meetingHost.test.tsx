import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingCard } from "./MeetingCard";
import { meetingCard } from "./meetingWorkspace.test";

const viewer = vi.hoisted(() => ({ id: "none" }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], viewerId: viewer.id }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

describe("成员主持会议", () => {
  it("主持人有开始会议，其他参会人只读，双方都看得到群组材料", () => {
    const card = meetingCard({ purpose: "对齐预算" }, [{ actionId: "end", actionType: "meeting.end", label: "这场会开完了" }]);
    const render = () => renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined}
      onNavigate={() => undefined} readOnly />);
    viewer.id = "p1";
    expect(render()).toContain("开始会议");
    expect(render()).toContain("群组材料");
    viewer.id = "someone-else";
    expect(render()).not.toContain("开始会议");
    expect(render()).toContain("群组材料");
  });
});
