import { describe, expect, it } from "vitest";
import { monthEnd, sortHomeProjects } from "./derive";
import { ago, fromHome, fromListed, mainGoal, projectLine, type Project } from "./projects";
import type { HomeProject, WorkHomeData } from "./types";

const SUMMARY = { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 };
const goal = (taskId: string, name: string, period = "2026-11", extra: Partial<HomeProject["goals"][number]> = {}): HomeProject["goals"][number] => ({
  taskId, missionId: "m1", name, period, dueDate: monthEnd(period), criteria: ["a", "b"], criteriaMet: 1, criteriaTotal: 2, completedAt: null, responsible: null, ...extra,
});
const home = (projectId: string, extra: Partial<HomeProject> = {}): HomeProject => ({
  projectId, name: projectId, goals: [], budget: null, lastActivityAt: "2026-11-07T01:00:00.000Z", summary: SUMMARY,
  pipeline: { conversationId: null, scope: `project:${projectId}` }, planning: false, subSessions: [], items: [], transfer: null, ...extra,
});
const data = { period: "2026-11", month: { missions: [{ missionId: "m1", title: "新首页", period: "2026-11", tasks: [] }] } } as unknown as Pick<WorkHomeData, "month" | "period">;

describe("项目从首页 v2 来（16.2、16.3）", () => {
  it("目标的截止写成「11/30」，Mission 名从「本月」里找；本月的进 current，之前月份没了结的留在 goals；scope 是项目对话", () => {
    const project = fromHome(home("p1", { goals: [goal("t0", "会议写进本体", "2026-10"), goal("t1", "对所有 DRI 开放")], summary: { ...SUMMARY, needsYou: 2 } }), data, new Map());
    expect(project.goals.map((entry) => [entry.taskId, entry.due, entry.missionTitle])).toEqual([["t0", "10/31", "新首页"], ["t1", "11/30", "新首页"]]);
    expect(project.current.map((entry) => entry.taskId)).toEqual(["t1"]);
    expect(project).toMatchObject({ id: "p1", scope: "project:p1", waiting: 2, archived: false, folder: null });
    expect(mainGoal(project)?.taskId).toBe("t1");
    expect(mainGoal({ ...project, current: [] })?.taskId).toBe("t0");
  });

  it("文件夹照这台电脑的本机程序；转交跟着项目回来；交出去了的在归档列表里（只读）；目标的负责人不是本人时带上那个人", () => {
    const transfer = { id: "x", projectId: "p1", projectName: "p1", from: { personId: "a", name: "甲" }, to: { personId: "b", name: "乙" }, status: "sent" as const,
      startedAt: "2026-11-07T01:00:00.000Z", decidedAt: "2026-11-07T02:00:00.000Z", includeHistory: false, running: null, check: null, note: null, checkResult: null, clone: null, afterSequence: null };
    const project = fromHome(home("p1", { transfer, goals: [goal("t1", "a", "2026-11", { responsible: { personId: "a", name: "甲" } })] }), data, new Map([["p1", "Tianshu-MVP"]]));
    expect(project).toMatchObject({ folder: "Tianshu-MVP", archived: false, transfer: { status: "sent" } });
    expect(project.goals[0]!.responsible).toEqual({ personId: "a", name: "甲" });
    expect(projectLine(project).text).toBe("等 乙 接手");
    const listed = fromListed({ projectId: "p9", name: "旧项目", archivedAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-01T00:00:00.000Z", lastActivityAt: null, permissionMode: "auto",
      transfer: { ...transfer, status: "accepted" } }, new Map());
    expect(listed).toMatchObject({ id: "p9", name: "旧项目", archived: true, goals: [], subSessions: [], scope: "project:p9", transfer: { status: "accepted" } });
    expect(projectLine(listed).text).toBe("已交给 乙");
  });
});

describe("项目行（16.2）", () => {
  const project = (patch: Partial<Project>): Project => ({
    id: "p", name: "p", folder: null, archived: false, goals: [], current: [], subSessions: [], items: [], scope: "project:p",
    waiting: 0, lastActivity: null, budget: null, transfer: null, ...patch,
  });
  const current = fromHome(home("p", { goals: [goal("t1", "对所有 DRI 开放")] }), data, new Map()).goals;

  it("第二行按顺序取：预算 80%（琥珀）→ 目标 · 截止 → 本月没有目标 · 最近活动", () => {
    const now = Date.parse("2026-11-07T10:00:00.000Z");
    expect(projectLine(project({ budget: { percent: 80, state: "warning" }, goals: current }), now)).toEqual({ text: "预算 80%", warning: true });
    expect(projectLine(project({ goals: current }), now)).toEqual({ text: "11 月 · 对所有 DRI 开放 · 11/30 验收", warning: false });
    expect(projectLine(project({ lastActivity: "2026-11-07T08:00:00.000Z" }), now).text).toBe("本月没有目标 · 2 小时前");
    expect(projectLine(project({}), now).text).toBe("本月没有目标");
    expect([ago("2026-11-07T09:59:30.000Z", now), ago("2026-11-04T10:00:00.000Z", now)]).toEqual(["刚刚", "3 天前"]);
  });

  it("回退路径的排序（接口在时云端排好）：有等你的在前；然后有目标的按最早的截止；最后按最近动静", () => {
    const list = [
      home("idle-old", { lastActivityAt: "2026-11-01T00:00:00.000Z" }),
      home("late", { goals: [goal("t2", "b", "2026-12")] }),
      home("idle-new", { lastActivityAt: "2026-11-06T00:00:00.000Z" }),
      home("soon", { goals: [goal("t1", "a")] }),
      home("waiting", { summary: { ...SUMMARY, needsYou: 1 }, lastActivityAt: "2026-10-01T00:00:00.000Z" }),
    ];
    expect(sortHomeProjects(list).map((entry) => entry.projectId)).toEqual(["waiting", "soon", "late", "idle-new", "idle-old"]);
    expect([monthEnd("2026-11"), monthEnd("2026-02"), monthEnd("2028-02"), monthEnd("2026-12")]).toEqual(["2026-11-30", "2026-02-28", "2028-02-29", "2026-12-31"]);
  });
});
