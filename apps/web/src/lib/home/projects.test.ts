import { describe, expect, it } from "vitest";
import type { WorkHomeData } from "./types";
import { NO_EDITS, ago, conversationTask, deriveProjects, missionProject, projectLine, sortProjects, type Project } from "./projects";

const task = (taskId: string, name: string, extra: Record<string, unknown> = {}) => ({
  taskId, name, subtitle: null, summary: {}, pipeline: { conversationId: null, scope: `plan-task:${taskId}` }, planning: false, completedAt: null, subSessions: [], items: [], ...extra,
});
const data = {
  period: "2026-11",
  missions: [
    { missionId: "m10", title: "会议回流", period: "2026-10", tasks: [task("t0", "会议写进本体")] },
    { missionId: "m1", title: "新首页", period: "2026-11", tasks: [task("t1", "对所有 DRI 开放"), task("t2", "首周数据")] },
    { missionId: "m2", title: "灯塔", period: "2026-11", tasks: [task("t3", "王总首用")] },
  ],
  waiting: [{ taskId: "t3" }],
} as unknown as WorkHomeData;
const due: Record<string, string> = { m1: "11/21", m2: "11/14", m10: "10/31" };

describe("项目从树上推（16.5 迁移的规矩）", () => {
  it("每个 Mission 一个同名项目，下面的 Task 都挂上；本月的按截止排在 current", () => {
    const { projects, unattached } = deriveProjects(data, NO_EDITS, (id) => due[id] ?? null);
    expect(projects.map((project) => [project.id, project.name, project.current.map((goal) => goal.taskId)])).toEqual([
      ["mission:m10", "会议回流", []], ["mission:m1", "新首页", ["t1", "t2"]], ["mission:m2", "灯塔", ["t3"]],
    ]);
    expect(unattached).toEqual([]);
  });

  it("改挂、摘掉、新建、改名、归档、绑文件夹都照本人的改动", () => {
    const edits = { ...NO_EDITS, created: [{ id: "local:a", name: "本机程序", createdAt: "2026-11-07T01:00:00.000Z" }],
      attach: { t2: "local:a", t3: null }, names: { [missionProject("m1")]: "天枢 · 新首页" }, archived: { [missionProject("m10")]: true }, folders: { "local:a": "Tianshu-MVP" } };
    const { projects, unattached } = deriveProjects(data, edits, (id) => due[id] ?? null);
    const byId = new Map(projects.map((project) => [project.id, project]));
    expect(byId.get("local:a")).toMatchObject({ name: "本机程序", folder: "Tianshu-MVP", lastActivity: "2026-11-07T01:00:00.000Z" });
    expect(byId.get("local:a")!.current.map((goal) => goal.taskId)).toEqual(["t2"]);
    expect(byId.get("mission:m1")!.name).toBe("天枢 · 新首页");
    expect(byId.get("mission:m10")!.archived).toBe(true);
    expect(unattached.map((goal) => goal.taskId)).toEqual(["t3"]);
  });
});

describe("项目行（16.2）", () => {
  const project = (patch: Partial<Project>): Project => ({ id: "p", name: "p", folder: null, archived: false, goals: [], current: [], tasks: [], subSessions: [], waiting: 0, lastActivity: null, budget: null, transfer: null, ...patch });
  const goal = { taskId: "t1", missionId: "m1", missionTitle: "新首页", period: "2026-11", name: "对所有 DRI 开放", due: "11/21" };

  it("第二行按顺序取：预算 80%（琥珀）→ 本月目标 · 截止 → 本月没有目标 · 最近活动", () => {
    const now = Date.parse("2026-11-07T10:00:00.000Z");
    expect(projectLine(project({ budget: 80, current: [goal] }), now)).toEqual({ text: "预算 80%", warning: true });
    expect(projectLine(project({ budget: 40, current: [goal] }), now)).toEqual({ text: "11 月 · 对所有 DRI 开放 · 11/21 验收", warning: false });
    expect(projectLine(project({ lastActivity: "2026-11-07T08:00:00.000Z" }), now).text).toBe("本月没有目标 · 2 小时前");
    expect(projectLine(project({}), now).text).toBe("本月没有目标");
    expect([ago("2026-11-07T09:59:30.000Z", now), ago("2026-11-04T10:00:00.000Z", now)]).toEqual(["刚刚", "3 天前"]);
  });

  it("排序：有等你的在前；然后本月有目标的按截止；最后按最近活动", () => {
    const list = [
      project({ id: "idle-old", lastActivity: "2026-11-01T00:00:00.000Z" }),
      project({ id: "late", current: [{ ...goal, due: "11/28" }] }),
      project({ id: "idle-new", lastActivity: "2026-11-06T00:00:00.000Z" }),
      project({ id: "soon", current: [{ ...goal, due: "11/14" }] }),
      project({ id: "waiting", waiting: 1, lastActivity: "2026-10-01T00:00:00.000Z" }),
    ];
    expect(sortProjects(list).map((entry) => entry.id)).toEqual(["waiting", "soon", "late", "idle-new", "idle-old"]);
  });

  it("项目对话接本月截止最早的那件，本月没有就接最近一个月的", () => {
    const old = { ...goal, taskId: "t0", period: "2026-10" };
    expect(conversationTask(project({ current: [goal], goals: [goal, old] }))?.taskId).toBe("t1");
    expect(conversationTask(project({ goals: [old] }))?.taskId).toBe("t0");
    expect(conversationTask(project({}))).toBeNull();
  });
});
