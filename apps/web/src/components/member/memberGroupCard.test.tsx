import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";

const detail = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ viewerId: "member-1", close: vi.fn() }), useRegisterDetail: detail.register }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div> }));
import { MemberGroupCard } from "./MemberGroupCard";

const card = (kind: "issue" | "meeting", payload: unknown): Card => ({ schemaVersion: 1, id: `${kind}:object-1`, version: 1,
  kind, title: kind === "issue" ? "渠道议题" : "渠道会议", objectRef: { type: kind, id: "object-1", version: 1 }, payload, actions: [] });

describe("成员只读群组卡", () => {
  it("议题只展示缘由、研究与判断，登记群聊频道", () => {
    const html = renderToStaticMarkup(<MemberGroupCard card={card("issue", { status: "pending", urgency: { level: "red" }, location: { level: "company" }, whyNow: "窗口即将关闭",
      research: { status: "ready", doc: { summary: "先核对数据", options: [], evidence: [], unknowns: [], sources: [] } }, receipts: [] })} />);
    expect(html).toContain("窗口即将关闭");
    expect(html).toContain("先核对数据");
    expect(html).not.toContain("安排会议");
    expect(html).not.toContain("移出议题");
    expect(detail.register).toHaveBeenCalledWith(expect.objectContaining({ group: expect.objectContaining({ objectType: "issue", viewerId: "member-1" }) }));
  });
  it("会议展示材料文字和会后结论，不出现录音与编辑入口", () => {
    const html = renderToStaticMarkup(<MemberGroupCard card={card("meeting", { status: "scheduled", scheduledAt: "2026-09-30T02:00:00Z", endsAt: "2026-09-30T03:00:00Z",
      leadDriId: "member-1", participants: [{ personId: "member-1", displayName: "测试乙" }], purpose: "对齐渠道", preflightBrief: "先看数据",
      materials: [{ id: "mat-1", fileName: "计划.md", extractedText: "材料正文" }], outcome: { items: [{ id: "i1", kind: "todo", text: "核对预算" }] } })} />);
    expect(html).toContain("材料正文");
    expect(html).toContain("核对预算");
    expect(html).toContain("下载原件");
    expect(html).not.toContain("录音");
    expect(html).not.toContain("编辑会议");
  });
});
