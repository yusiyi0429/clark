import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/me", useSearchParams: () => null, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/meeting/MeetingCardNotices", async (original) => ({
  ...(await original<typeof import("@/components/meeting/MeetingCardNotices")>()),
  useMeetingRecords: () => records,
}));

let records: { meetings: unknown[]; confirms: unknown[]; deferred: unknown[]; minutes: unknown[]; reload: () => void } = {
  meetings: [], confirms: [{ meetingId: "m1", title: "接口切换会", kind: "decision", id: "dec-1", text: "接口统一改成 v2", dueDate: null }], deferred: [], minutes: [], reload: () => undefined,
};

import { MemberWorkspace } from "./MemberWorkspace";

describe("成员通知栏：会议记录", () => {
  it("有要我确认的决策时不显示「暂时没有新通知」", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain("决策确认");
    expect(html).toContain("接口统一改成 v2");
    expect(html).toContain("来自「接口切换会」");
    expect(html).not.toContain("暂时没有新通知");
  });

  it("只有一条待整理时也不显示「暂时没有新通知」", () => {
    records = {
      meetings: [],
      confirms: [],
      deferred: [],
      minutes: [{ minuteToken: "obcn1", title: "产品周会", startsAt: "2026-10-23T06:00:00.000Z", endsAt: "2026-10-23T07:10:00.000Z", attendees: [], otherAttendees: 0, suggestion: null }],
      reload: () => undefined,
    };
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain("产品周会");
    expect(html).not.toContain("暂时没有新通知");
  });
});
