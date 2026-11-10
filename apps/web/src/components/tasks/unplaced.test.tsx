import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { THomePlanResponse, TTaskView } from "@warmap/contracts";

const api = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { POST: api.post, PATCH: api.patch } }));

import { attachTask, unplacedLine, unplacedNotices } from "./Unplaced";
import { MissionList } from "@/components/member/home/MissionList";

const task = (extra: Partial<TTaskView> = {}): TTaskView => ({
  id: "t1", version: 3, title: "研究一号位外部数据源的付费模式", status: "not_started", source: "meeting", startDate: null, dueDate: null, doneDefinition: null,
  card: { stage: "todo", wait: null, role: null, executor: null, model: null, criterion: null, run: null, handback: null, deliverable: null, after: [], sourceWords: [] },
  mission: null, waitingOn: null, owner: { personId: "sun", name: "孙铭泽" }, collaborators: [], latestProgress: null, returnReason: null,
  origin: { type: "meeting", meetingId: "m1", meetingTitle: "inception review", quote: null }, awaitingAcceptance: false, planTaskId: null, blocker: null,
  unplaced: { reason: "你名下没有和数据源调研对得上的 Mission" }, createdAt: "2026-10-26T08:00:00Z", updatedAt: "2026-10-26T08:00:00Z", ...extra,
});

beforeEach(() => {
  api.post.mockReset(); api.patch.mockReset();
  vi.stubGlobal("window", new EventTarget());
});

describe("待归位", () => {
  it("小字写从哪来和为什么没挂上；没有原因、Agent 建的也有一句", () => {
    expect(unplacedLine(task())).toBe("「inception review」分配给你 · 你名下没有和数据源调研对得上的 Mission");
    expect(unplacedLine(task({ origin: null, source: "agent", unplaced: { reason: null } }))).toBe("外部工具建的 · 还没有所属 Mission");
  });

  it("通知栏一条：「挂到…」进事项详情；「不属于任何 Mission」写一句就办完", async () => {
    const open = vi.fn();
    const [notice] = unplacedNotices([task()], open);
    expect(notice).toMatchObject({ title: "研究一号位外部数据源的付费模式", tone: "amber" });
    expect(await notice.buttons[0].run()).toEqual({ ok: false, cancelled: true });
    expect(open).toHaveBeenCalledWith("t1", null);
    api.post.mockResolvedValue({ data: task({ unplaced: undefined }), error: undefined });
    expect(await notice.reason!.run("一次性的调研")).toEqual({ ok: true, settled: "已确认不属于任何 Mission" });
    expect(api.post).toHaveBeenCalledWith("/api/me/tasks/{id}/standalone", { params: { path: { id: "t1" } }, body: { version: 3, reason: "一次性的调研" } });
  });

  it("挂上：带当前版本 PATCH missionId，没成功说原因", async () => {
    api.patch.mockResolvedValue({ data: undefined, error: { message: "个人任务不可用于执行事项" } });
    expect(await attachTask(task(), "m-up")).toBe("个人任务不可用于执行事项");
    expect(api.patch).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "t1" } }, body: { version: 3, missionId: "m-up" } });
  });

  it("首页 Mission 列表：有待归位时「全部」下面多一行「待归位 N 件」，没有就不出", () => {
    const plan = { missions: [], activities: [], unplaced: [task(), task({ id: "t2" })], gates: [], today: "2026-10-26", fallbackFrom: null } as unknown as THomePlanResponse;
    const html = renderToStaticMarkup(<MissionList plan={plan} focus={null} onChoose={() => undefined} />);
    expect(html).toContain('data-mission="unplaced"');
    expect(html).toContain("待归位");
    expect(html).toContain("2 件");
    expect(renderToStaticMarkup(<MissionList plan={{ ...plan, unplaced: [] }} focus={null} onChoose={() => undefined} />)).not.toContain("待归位");
  });
});
