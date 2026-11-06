import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TTaskView } from "@warmap/contracts";
import { LinkedTaskRows } from "./MonthPlan";

const task: TTaskView = {
  id: "00000000-0000-4000-8000-000000000001", version: 1, title: "准备上线", status: "in_progress", source: "plan",
  startDate: null, dueDate: "2026-10-08", doneDefinition: null, mission: { missionId: "m", title: "上线", cardId: "c", period: "2026-10", battlefieldName: "增长", step: 1, steps: 2 },
  waitingOn: null, awaitingAcceptance: false, planTaskId: null, blocker: null, owner: { personId: "owner", name: "孙铭泽" }, collaborators: [],
  latestProgress: { body: "完成接口核对", source: "codex", author: { personId: "owner", name: "孙铭泽" }, createdAt: "2026-10-05T06:20:00Z" },
  returnReason: null, origin: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-05T06:20:00Z",
  card: { stage: "todo", wait: null, role: null, executor: null, model: null, criterion: null, run: null, handback: null, deliverable: null },
};
describe("任务卡执行事项行", () => {
  it("拍板人可读摘要和最新进展，但行不可打开；成员可打开", () => {
    const decider = renderToStaticMarkup(<LinkedTaskRows tasks={[task]} viewerId="ceo" />);
    expect(decider).toContain("准备上线"); expect(decider).toContain("最新进展 · Codex");
    expect(decider).toContain("完成接口核对"); expect(decider).not.toContain("data-target");
    const owner = renderToStaticMarkup(<LinkedTaskRows tasks={[task]} viewerId="owner" />);
    expect(owner).toContain("data-target");
  });
  it("不写步骤序号：挂在任务下的只写截止和参与人，独立事项照旧标出", () => {
    const html = renderToStaticMarkup(<LinkedTaskRows tasks={[task, { ...task, id: "00000000-0000-4000-8000-000000000003", title: "单独一件", mission: null }]} viewerId="owner" />);
    expect(html).not.toContain("步");
    expect(html).toContain("10/8 前 · 孙铭泽");
    expect(html).toContain("独立事项 · 10/8 前");
  });
  it("完成的事项收进默认折叠的「已完成 N」", () => {
    const html = renderToStaticMarkup(<LinkedTaskRows tasks={[task, { ...task, id: "00000000-0000-4000-8000-000000000002", title: "旧的一步", status: "done" }]} viewerId="owner" />);
    expect(html).toContain("准备上线");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("旧的一步");
  });
});
