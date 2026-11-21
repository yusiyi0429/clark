import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AddReviewLinkRequest, MonthCarryoverResponse, MonthReviewResponse, PutReviewCriterionRequest, PutReviewDispositionRequest } from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const uuid = "8a6f0c1e-4b7d-4f1a-9c3e-2d5b6a7c8d9e";

beforeAll(() => {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f-]{36}$/.test(v));
});

describe("复盘第三版契约", () => {
  const person = { personId: "p-1", name: "孙明泽" };
  const criterion = { index: 1, text: "Mac 版能装", agentRating: "partial", agentBasis: "对这条的卡还没验收过", rating: "met", ratedBy: person,
    note: "11/28 装好了", links: [{ id: uuid, title: "PR #80", url: "https://github.com/x/y/pull/80", source: "person" }] };
  const task = { taskId: "T-1", name: "本机程序", missionId: "M-1", missionTitle: "新首页", responsible: person, disposition: "current", deferredTo: null,
    dispositionBy: null, canChange: true, criteria: [criterion] };
  const page = { period: "2026-11", deadline: "2026-12-01T10:00:00.000Z", prefill: { status: "done", error: null }, toConfirm: 1, deferred: 1, cancelled: 0,
    missions: [{ missionId: "M-1", code: "M1", title: "新首页", owner: person, verdict: "partial", met: 4, total: 5, deferred: 1, cancelled: 0,
      confirmedAt: null, confirmedBy: null, canConfirm: true, tasks: [task] }],
    setAside: [{ ...task, taskId: "T-2", disposition: "deferred", deferredTo: "2026-12", dispositionBy: person, criteria: [] }] };

  it("复盘页：Mission 块、逐条评定、延期和取消放最下面", () => {
    expect(Value.Check(MonthReviewResponse, page)).toBe(true);
    expect(Value.Check(MonthReviewResponse, { ...page, missions: [{ ...page.missions[0], verdict: null }] })).toBe(true);
    expect(Value.Check(MonthReviewResponse, { ...page, missions: [{ ...page.missions[0], verdict: "done" }] })).toBe(false);
    expect(Value.Check(MonthReviewResponse, { ...page, setAside: [{ ...task, disposition: "paused" }] })).toBe(false);
    expect(Value.Check(MonthReviewResponse, { ...page, missions: [{ ...page.missions[0], tasks: [{ ...task, criteria: [{ ...criterion, rating: "good" }] }] }] })).toBe(false);
  });

  it("写操作的请求体", () => {
    expect(Value.Check(PutReviewDispositionRequest, { disposition: "deferred", deferredTo: "2027-01" })).toBe(true);
    expect(Value.Check(PutReviewDispositionRequest, { disposition: "cancelled" })).toBe(true);
    expect(Value.Check(PutReviewDispositionRequest, { disposition: "deferred", deferredTo: "12 月" })).toBe(false);
    expect(Value.Check(PutReviewCriterionRequest, { rating: "unmet", note: null })).toBe(true);
    expect(Value.Check(PutReviewCriterionRequest, { rating: "unmet" })).toBe(false);
    expect(Value.Check(AddReviewLinkRequest, { url: "https://feishu.cn/docx/abc" })).toBe(true);
    expect(Value.Check(AddReviewLinkRequest, { candidate: { kind: "output", id: uuid } })).toBe(true);
    expect(Value.Check(AddReviewLinkRequest, { candidate: { kind: "card", id: uuid } })).toBe(false);
  });

  it("顺延清单", () => {
    expect(Value.Check(MonthCarryoverResponse, { period: "2026-12", tasks: [{ taskId: "T-2", name: "本机程序发布", missionId: "M-1", missionTitle: "新首页",
      fromPeriod: "2026-11", deferredTo: "2026-12", criteria: [{ index: 1, text: "Mac 版能装", rating: null, note: null, links: [] }] }] })).toBe(true);
  });

  it("OpenAPI 里列了复盘页的路径", () => {
    const paths = buildOpenApiDocument().paths;
    for (const [key, methods] of [["/api/me/months/{period}/review", ["get"]], ["/api/me/months/{period}/review/tasks/{taskId}/disposition", ["put"]],
      ["/api/me/months/{period}/review/tasks/{taskId}/criteria/{index}", ["put"]], ["/api/me/months/{period}/review/tasks/{taskId}/criteria/{index}/links", ["post"]],
      ["/api/me/months/{period}/review/links/{linkId}", ["delete"]], ["/api/me/months/{period}/review/tasks/{taskId}/link-candidates", ["get"]],
      ["/api/me/months/{period}/review/missions/{missionId}/confirm", ["post"]], ["/api/me/months/{period}/carryover", ["get"]]] as const)
      expect(Object.keys(paths[key] ?? {})).toEqual(methods);
  });
});
