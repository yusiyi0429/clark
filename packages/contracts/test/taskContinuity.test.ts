import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ContinueTaskResponse, MonthPageResponse, StopTaskRequest, TaskAgreementResponse, TaskSettlementResponse } from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const at = "2026-12-01T02:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

const to = { taskId: "T-12", name: "12 月接着做", missionId: "M-12", period: "2026-12" };
const continued = { kind: "continued", at, by: "p-1", note: null, to };

describe("跨月延续与月份页契约", () => {
  it("延续、到此为止的回执：了结三种，延续带去了哪", () => {
    expect(Value.Check(ContinueTaskResponse, { taskId: "T-11", settlement: continued,
      moved: { cards: 2, topics: 1, pending: 0, splits: 0, planners: 1, drafts: 3, pipeline: true, agreement: true } })).toBe(true);
    expect(Value.Check(TaskSettlementResponse, { taskId: "T-11", settlement: { kind: "stopped", at, by: "p-1", note: "方向变了", to: null } })).toBe(true);
    expect(Value.Check(TaskSettlementResponse, { taskId: "T-11", settlement: { kind: "paused", at, by: "p-1", note: null, to: null } })).toBe(false);
    expect(Value.Check(StopTaskRequest, {})).toBe(true);
    expect(Value.Check(StopTaskRequest, { note: "" })).toBe(false);
  });

  it("月份页：每件 Task 的摘要、了结、延续自哪；草稿先是 null；不再带复盘答案", () => {
    // 本月页（迁移 290–293）：约定 met/total 换成逐条的完成标准，另有 Mission 成果、改动、添的、验收时间点和「原」、去向。
    const task = { taskId: "T-11", missionId: "M-11", missionTitle: "内部版上线", missionOutcome: "内部版能用", name: "上线 V1",
      criteria: [{ text: "有题库打分", met: true, changed: false, original: null, removed: false }, { text: "有录屏", met: false, changed: true, original: "有截图", removed: false },
        { text: "有周报", met: false, changed: false, original: null, removed: true }, { text: "有复盘", met: false, changed: false, original: null, removed: false }],
      edited: { name: null, criteria: ["有题库打分", "有截图", "有周报", "有复盘"] }, added: false, dueDate: "2026-11-25", missionDueDate: "2026-11-18",
      disposition: "current", deferredTo: null, version: 2, running: 1, blocked: 0, done: false, settlement: continued, continuedFrom: null };
    expect(Value.Check(MonthPageResponse, { period: "2026-11", tasks: [task], draft: null })).toBe(true);
    expect(Value.Check(MonthPageResponse, { period: "2026-11", tasks: [{ ...task, missionOutcome: null, edited: null, dueDate: null, missionDueDate: null,
      disposition: "deferred", deferredTo: "2026-12", version: null, settlement: null, continuedFrom: { ...to, period: null } }],
    draft: { period: "2026-12", missions: [{ id: "m", title: "12 月的 Mission", tasks: [{ id: "d", name: "接着做",
      continuesFrom: { taskId: "T-11", name: "上线 V1", period: "2026-11", summary: "约定 1/3 · 交付第 2 版" } }] }] } })).toBe(true);
    expect(Value.Check(MonthPageResponse, { period: "11 月", tasks: [], draft: null })).toBe(false);
    expect(Value.Check(MonthPageResponse, { period: "2026-11", tasks: [{ ...task, agreement: { met: 0, total: 0 } }], draft: null })).toBe(false);
    expect(Value.Check(MonthPageResponse, { period: "2026-11", tasks: [{ ...task, answer: null }], draft: null })).toBe(false);
    // 标准的每条都要说是不是删掉的本体标准。
    expect(Value.Check(MonthPageResponse, { period: "2026-11", tasks: [{ ...task, criteria: [{ text: "有题库打分", met: true, changed: false, original: null }] }], draft: null })).toBe(false);
    // 本月页新加的字段缺哪个都不行。
    for (const key of ["missionOutcome", "criteria", "edited", "added", "dueDate", "missionDueDate", "disposition", "deferredTo"] as const) {
      const { [key]: _dropped, ...without } = task;
      expect(Value.Check(MonthPageResponse, { period: "2026-11", tasks: [without], draft: null }), key).toBe(false);
    }
  });

  it("约定带 draftFrom（延续来的草稿）", () => {
    const agreement = { taskId: "T-12", taskName: "接着做", missionId: "M-12", basis: "acceptance", source: "tianshu", criteria: [], exclusions: [], complete: false,
      basisChanged: true, canEdit: true, updatedBy: null, updatedAt: null };
    expect(Value.Check(TaskAgreementResponse, { ...agreement, draftFrom: "T-11" })).toBe(true);
    expect(Value.Check(TaskAgreementResponse, { ...agreement, draftFrom: null })).toBe(true);
    expect(Value.Check(TaskAgreementResponse, agreement)).toBe(false);
  });

  it("OpenAPI 里列了延续和月份页的路径", () => {
    const paths = buildOpenApiDocument().paths;
    expect(Object.keys(paths["/api/me/tasks/{taskId}/stop"] ?? {}).sort()).toEqual(["delete", "post"]);
    expect(paths["/api/me/months/{period}/tasks/{taskId}/decision"]).toBeUndefined();
    for (const key of ["/api/me/tasks/{taskId}/continuation", "/api/me/months/{period}"]) expect(paths[key]).toBeDefined();
  });
});
