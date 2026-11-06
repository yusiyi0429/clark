import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AcceptCardDraftsRequest, BackgroundQuery, BackgroundResponse, ClaimSessionStartsResponse, ConversationScope, RouteResponse, TaskPipelineResponse, WorkHomeResponse,
} from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const uuid = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const at = "2026-11-07T08:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

const sub = { id: uuid, kind: "card", title: "修登录页", state: "waiting", waiting: "approval", queueReason: null, role: null, sessionId: uuid, deviceId: uuid,
  autoStart: false, updatedAt: at };
const resources = { devices: [], running: 0, cap: null, cost: { today: { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null },
  month: { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null } } };

describe("新首页契约", () => {
  it("首页：Mission → Task → 子会话，其他，等你", () => {
    const home = {
      missions: [{ missionId: "M1", title: "上线", tasks: [{ taskId: "T-1", missionId: "M1", name: "11/18 上线 V1", subtitle: null,
        summary: { running: 0, waiting: 1, queued: 0, done: 0 }, pipeline: { conversationId: null, scope: "plan-task:T-1" }, planning: false, subSessions: [sub] }] }],
      other: { subSessions: [{ ...sub, kind: "topic", state: "queued", waiting: null, queueReason: "device_offline", sessionId: null, deviceId: null, autoStart: true }] },
      waiting: [{ id: `approval:${uuid}`, kind: "approval", title: "要运行命令", source: "修登录页 · 11/18 上线 V1", at, open: { kind: "card", id: uuid },
        taskId: "T-1", sessionId: uuid, deviceId: uuid }],
    };
    expect(Value.Check(WorkHomeResponse, home)).toBe(true);
    // 子会话只有卡和专题；规划员、验收员是后台任务。
    expect(Value.Check(WorkHomeResponse, { ...home, other: { subSessions: [{ ...sub, kind: "plan" }] } })).toBe(false);
    expect(Value.Check(WorkHomeResponse, { ...home, other: { subSessions: [{ ...sub, waiting: "paused" }] } })).toBe(false);
  });

  it("后台任务：scope 只认 main、task、card、topic；条目带停哪个会话", () => {
    expect(Value.Check(BackgroundQuery, { scope: "main" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "task:T-A" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: `card:${uuid}` })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: `topic:${uuid}` })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "all" })).toBe(false);
    expect(Value.Check(BackgroundQuery, { scope: "card:x" })).toBe(false);
    expect(Value.Check(BackgroundResponse, { resources, items: [{ id: `bg:${uuid}:t1`, title: "跑测试", kind: "command", state: "running", startedAt: at, finishedAt: null,
      stoppable: true, sessionId: uuid, itemId: "t1", deviceId: uuid, taskId: "T-1", cardId: uuid, topicId: null }] })).toBe(true);
  });

  it("Task 管线、自动分发、认领开工", () => {
    expect(Value.Check(TaskPipelineResponse, { taskId: "T-1", conversationId: uuid, scope: "plan-task:T-1" })).toBe(true);
    expect(Value.Check(RouteResponse, { target: "main" })).toBe(true);
    expect(Value.Check(RouteResponse, { target: { taskId: "T-1" } })).toBe(true);
    expect(Value.Check(RouteResponse, { target: "task" })).toBe(false);
    expect(Value.Check(ClaimSessionStartsResponse, { starts: [{ id: uuid, kind: "card", cardId: uuid, topicId: null, taskId: "T-1", requestedAt: at }] })).toBe(true);
    expect(Value.Check(AcceptCardDraftsRequest, { drafts: [{ id: uuid }], start: true })).toBe(true);
  });

  it("对话 scope 认 Task 管线 plan-task:<taskId>", () => {
    expect(Value.Check(ConversationScope, "plan-task:T-A")).toBe(true);
    expect(Value.Check(ConversationScope, "plan-task:obj_01.x")).toBe(true);
    expect(Value.Check(ConversationScope, "plan-task:")).toBe(false);
    expect(Value.Check(ConversationScope, "global")).toBe(true);
  });

  it("OpenAPI 里列了新首页的路径", () => {
    const paths = buildOpenApiDocument().paths;
    for (const key of ["/api/me/work-home", "/api/me/background", "/api/me/tasks/{taskId}/pipeline", "/api/me/route", "/api/me/session-starts/claim",
      "/api/me/session-starts/{id}/release"]) expect(paths[key]).toBeDefined();
  });
});
