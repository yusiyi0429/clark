import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingCard } from "./MeetingCard";
import { meetingCard } from "./meetingWorkspace.test";
import { escapeToSegment, initialMeetingView, meetingSegments, noPreflightContent, pickMaterial, pickSegment, selectedSegment } from "./meetingView";

vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], closing: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

const noop = () => undefined;
const render = (card: ReturnType<typeof meetingCard>) => renderToStaticMarkup(<MeetingCard card={card} collection={[]} onCard={noop} onNavigate={noop} />);
const materials = [{ id: "m-1", fileName: "预算.pdf", mimeType: "application/pdf", sizeBytes: 1024, receivedBy: "p2", providedBy: null, uploadedAt: "2026-09-20T01:00:00.000Z" }];

describe("会议页「会前预审 ｜ 会议记录」切换", () => {
  it("会前：页头没有会议记录入口，也不放切换；下拉单仍有 AI 预审", () => {
    const html = render(meetingCard({ materials }));
    expect(html).not.toContain("data-header-switch");
    expect(html).not.toContain('role="radiogroup"');
    expect(html).not.toContain("data-header-whole");
    expect(html).toContain("AI 预审");
    expect(meetingSegments(false)).toEqual([]);
  });

  it("会后：页头两段「会前预审」「会议记录」，默认选会议记录；下拉单只列材料", () => {
    const html = render(meetingCard({ status: "held", materials }));
    expect(html).toContain("data-header-switch");
    expect(html).toMatch(/role="radiogroup" aria-label="会议视图"/);
    expect(html).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*>会前预审</);
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>会议记录</);
    // 选中的那一段可 Tab 进入，另一段不在 Tab 顺序里。
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*>会议记录</);
    expect(html).toMatch(/aria-checked="false" tabindex="-1"[^>]*>会前预审</);
    expect(html).not.toContain("AI 预审");
    expect(meetingSegments(true).map((segment) => segment.label)).toEqual(["会前预审", "会议记录"]);
  });

  it("会开完了还没确认会议记录（已结束的 scheduled）也算会后，默认会议记录", () => {
    const html = render(meetingCard({ endedAt: "2025-09-24T15:40:00.000Z" }));
    expect(html).toMatch(/aria-checked="true"[^>]*>会议记录</);
    expect(initialMeetingView(true)).toEqual({ current: "record", segment: "record" });
    expect(initialMeetingView(false)).toEqual({ current: "preflight", segment: "preflight" });
  });

  it("选了某份材料两段都不选中；Esc 回到上次选中的那一段", () => {
    const fromRecord = pickMaterial(initialMeetingView(true), "m-1");
    expect(fromRecord).toEqual({ current: "m-1", segment: "record" });
    expect(selectedSegment(fromRecord)).toBeNull();
    expect(escapeToSegment(fromRecord)).toEqual({ current: "record", segment: "record" });

    const fromPreflight = pickMaterial(pickSegment("preflight"), "m-1");
    expect(selectedSegment(fromPreflight)).toBeNull();
    expect(selectedSegment(escapeToSegment(fromPreflight))).toBe("preflight");
    // 在材料之间换来换去，记住的那一段不变。
    expect(escapeToSegment(pickMaterial(fromPreflight, "m-2"))).toEqual({ current: "preflight", segment: "preflight" });
    // 会前下拉单里的「AI 预审」就是那一段。
    expect(pickMaterial(fromPreflight, "preflight")).toEqual({ current: "preflight", segment: "preflight" });
  });

  it("会后没有预审内容：「会前预审」段仍在，内容区写一句「该会议没有会前预审。」", () => {
    const empty = { status: "pending", entries: [], brief: "" };
    expect(noPreflightContent(true, empty)).toBe(true);
    expect(noPreflightContent(false, empty)).toBe(false);
    expect(noPreflightContent(true, { ...empty, status: "running" })).toBe(false);
    expect(noPreflightContent(true, { ...empty, brief: "预审摘要" })).toBe(false);
    expect(noPreflightContent(true, { ...empty, entries: [{}] })).toBe(false);
    const html = render(meetingCard({ status: "held", preflight: { status: "pending", entries: [], brief: "" } }));
    expect(html).toMatch(/role="radio"[^>]*>会前预审</);
  });
});
