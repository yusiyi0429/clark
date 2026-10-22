import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/me", useSearchParams: () => null, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/meeting/MeetingCardNotices", async (original) => ({
  ...(await original<typeof import("@/components/meeting/MeetingCardNotices")>()),
  useMyMeetingCards: () => [{ meetingId: "m1", title: "接口切换会", endedAt: "2026-10-20T06:00:00.000Z", status: "pending" }],
}));

import { MemberWorkspace } from "./MemberWorkspace";

describe("成员通知栏：会议记录", () => {
  it("有会议记录待确认时不显示「暂时没有新通知」", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain("接口切换会");
    expect(html).not.toContain("暂时没有新通知");
  });
});
