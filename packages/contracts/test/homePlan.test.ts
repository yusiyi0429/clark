import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  CreateMyTaskRequest, CreatePlanMarkRequest, HomePlanResponse, PatchMyTaskRequest, PatchPlanMarkRequest, TaskView,
} from "../src/index.js";

// 运行时的格式校验在 Fastify（ajv）里；这里只为 Value.Check 局部注册 uuid。
beforeAll(() => {
  FormatRegistry.Set("uuid", (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
});

const now = "2026-10-22T02:00:00.000Z";
const person = { personId: "sun-mingze", name: "孙铭泽" };
const mission = { missionId: "sun-202610-1", title: "CEO / DRI Agent 从能用到在用", cardId: "card-1", period: "2026-10", battlefieldName: "灯塔项目", step: 1, steps: 3 };
const activity = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  id, version: 2, title, status: "in_progress", source: "plan", startDate: "2026-10-19", dueDate: "2026-10-25", doneDefinition: null,
  mission, waitingOn: null, owner: person, collaborators: [], latestProgress: null, returnReason: null, origin: null,
  awaitingAcceptance: false, planTaskId: null, createdAt: now, updatedAt: now, ...extra,
});
const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
/** 10 月 31 天；2026-10-01 是周四，周六周日休息。 */
const days = Array.from({ length: 31 }, (_, i) => ({ date: day(i + 1), workday: ![3, 4, 10, 11, 17, 18, 24, 25, 31].includes(i + 1) }));

/** 设计稿里的 10 月：今天 10/22，本周 10/19–10/25，两个 Mission，10/28 上线。 */
const sample = {
  period: "2026-10", fallbackFrom: null, today: "2026-10-22", weekStart: "2026-10-19", weekEnd: "2026-10-25",
  days,
  missions: [
    { missionId: "sun-202610-1", code: "M1", title: "CEO / DRI Agent 从能用到在用", cardId: "card-1", color: "#2f63b0" },
    { missionId: "sun-202610-2", code: "M2", title: "灯塔首次会面", cardId: null, color: "#2f8a7a" },
  ],
  gates: [
    { missionId: "sun-202610-2", date: "2026-10-11", label: "首次会面" },
    { missionId: "sun-202610-1", date: "2026-10-28", label: "上线" },
  ],
  marks: [{ id: "7b0c3c1e-0000-4000-8000-000000000010", missionId: "sun-202610-1", date: "2026-10-24", label: "合入主干" }],
  tasks: [{ taskId: "task-1", missionId: "sun-202610-1", name: "会议写进本体", doneDefinition: "会后自动出会议卡，整卡确认后写进本体。", criteria: ["真实工作会走完全链路，读回一致", "飞书里直接开的会也接得住"] }],
  activities: [
    { item: activity("7b0c3c1e-0000-4000-8000-000000000001", "回流方案定稿", { status: "done", startDate: null, dueDate: "2026-10-21", planTaskId: "task-1" }), column: "done", overdue: false },
    { item: activity("7b0c3c1e-0000-4000-8000-000000000002", "真实会议跑通"), column: "week", overdue: false },
    { item: activity("7b0c3c1e-0000-4000-8000-000000000003", "新 Chat 题库打分", { status: "not_started", startDate: "2026-10-27", dueDate: null }), column: "later", overdue: false },
  ],
};

describe("首页 Mission 计划视图契约", () => {
  it("设计稿里的 10 月数据通过校验；本月没有 Mission 回退时 fallbackFrom 写明显示的是哪个月，空态也合法", () => {
    expect(Value.Check(HomePlanResponse, sample)).toBe(true);
    expect(Value.Check(HomePlanResponse, { ...sample, period: "2026-09", fallbackFrom: "2026-09" })).toBe(true);
    expect(Value.Check(HomePlanResponse, { ...sample, missions: [], gates: [], marks: [], tasks: [], activities: [] })).toBe(true);
    expect(Value.Check(HomePlanResponse, { ...sample, fallbackFrom: "2026-9" })).toBe(false);
  });

  it("计划点名字最多 10 个字，不能为空；没有计划点 id 或日期格式不对都不收", () => {
    const mark = sample.marks[0]!;
    expect(Value.Check(HomePlanResponse, { ...sample, marks: [{ ...mark, label: "一二三四五六七八九十" }] })).toBe(true);
    expect(Value.Check(HomePlanResponse, { ...sample, marks: [{ ...mark, label: "一二三四五六七八九十一" }] })).toBe(false);
    expect(Value.Check(HomePlanResponse, { ...sample, marks: [{ ...mark, label: "" }] })).toBe(false);
    expect(Value.Check(HomePlanResponse, { ...sample, marks: [{ ...mark, date: "10/24" }] })).toBe(false);
    const { id: _id, ...noId } = mark;
    expect(Value.Check(HomePlanResponse, { ...sample, marks: [noId] })).toBe(false);
  });

  it("Activity 的栏位只有三种；多出来的字段不收", () => {
    const [first] = sample.activities;
    expect(Value.Check(HomePlanResponse, { ...sample, activities: [{ ...first, column: "doing" }] })).toBe(false);
    expect(Value.Check(HomePlanResponse, { ...sample, activities: [{ ...first, extra: 1 }] })).toBe(false);
    expect(Value.Check(HomePlanResponse, { ...sample, days: [{ date: "2026-10-01", workday: true, holiday: false }] })).toBe(false);
  });

  it("执行事项必须带 planTaskId（没挂 Task 时为 null）", () => {
    const item = activity("7b0c3c1e-0000-4000-8000-000000000001", "回流方案定稿");
    expect(Value.Check(TaskView, item)).toBe(true);
    expect(Value.Check(TaskView, { ...item, planTaskId: "task-1" })).toBe(true);
    expect(Value.Check(TaskView, { ...item, planTaskId: "" })).toBe(false);
    const { planTaskId: _planTaskId, ...withoutPlanTaskId } = item;
    expect(Value.Check(TaskView, withoutPlanTaskId)).toBe(false);
    const [first] = sample.activities;
    expect(Value.Check(HomePlanResponse, { ...sample, activities: [{ ...first, item: withoutPlanTaskId }] })).toBe(false);
  });

  it("新建和修改执行事项可以带 planTaskId；修改时 null 表示不挂 Task，新建时不带就是没挂", () => {
    const request = { clientId: "00000000-0000-4000-8000-000000000000", title: "调研竞品的上线节奏", missionId: "sun-202610-1" };
    expect(Value.Check(CreateMyTaskRequest, request)).toBe(true);
    expect(Value.Check(CreateMyTaskRequest, { ...request, planTaskId: "task-1" })).toBe(true);
    expect(Value.Check(CreateMyTaskRequest, { ...request, planTaskId: "" })).toBe(false);
    expect(Value.Check(CreateMyTaskRequest, { ...request, planTaskId: null })).toBe(false);
    expect(Value.Check(PatchMyTaskRequest, { version: 3, planTaskId: "task-1" })).toBe(true);
    expect(Value.Check(PatchMyTaskRequest, { version: 3, planTaskId: null })).toBe(true);
    expect(Value.Check(PatchMyTaskRequest, { version: 3, planTaskId: "" })).toBe(false);
  });

  it("加计划点要写 Mission、日期和名字；改计划点至少带日期或名字之一", () => {
    const create = { missionId: "sun-202610-1", date: "2026-10-24", label: "合入主干" };
    expect(Value.Check(CreatePlanMarkRequest, create)).toBe(true);
    for (const invalid of [{ label: "" }, { label: "一二三四五六七八九十一" }, { date: "10/24" }, { missionId: "" }, { id: "x" }]) {
      expect(Value.Check(CreatePlanMarkRequest, { ...create, ...invalid })).toBe(false);
    }
    expect(Value.Check(CreatePlanMarkRequest, { missionId: create.missionId, date: create.date })).toBe(false);

    expect(Value.Check(PatchPlanMarkRequest, { date: "2026-10-26" })).toBe(true);
    expect(Value.Check(PatchPlanMarkRequest, { label: "改名" })).toBe(true);
    expect(Value.Check(PatchPlanMarkRequest, { date: "2026-10-26", label: "改名" })).toBe(true);
    expect(Value.Check(PatchPlanMarkRequest, {})).toBe(false);
    expect(Value.Check(PatchPlanMarkRequest, { label: "一二三四五六七八九十一" })).toBe(false);
    expect(Value.Check(PatchPlanMarkRequest, { missionId: "sun-202610-2" })).toBe(false);
  });
});
