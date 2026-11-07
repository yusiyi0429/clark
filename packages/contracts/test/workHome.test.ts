import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AcceptCardDraftsRequest, BackgroundQuery, BackgroundResponse, ClaimSessionStartsResponse, ConversationScope, RouteResponse, TaskFeedResponse, TaskPipelineResponse,
  WorkHomeResponse,
} from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const uuid = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const at = "2026-11-07T08:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

const sub = { id: uuid, kind: "card", title: "修登录页", state: "waiting", waiting: "approval", queueReason: null, role: null, sessionId: uuid, deviceId: uuid,
  autoStart: false, updatedAt: at, merge: null, holdUntil: null };
const resources = { devices: [], running: 0, cap: null, cost: { today: { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null },
  month: { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null } }, quota: [{ deviceId: uuid, deviceName: "我的电脑", source: "claude_subscription",
  windows: [{ kind: "weekly_all", model: null, usedPercent: 100, state: "blocked", resetsAt: at }], blockedUntil: at, updatedAt: at }] };

describe("新首页契约", () => {
  it("首页：Mission → Task → 子会话，其他，等你", () => {
    const home = {
      period: "2026-11",
      missions: [{ missionId: "M1", title: "上线", period: "2026-11", tasks: [{ taskId: "T-1", missionId: "M1", name: "11/18 上线 V1", subtitle: null,
        summary: { running: 0, waiting: 1, queued: 0, done: 0, doneToday: 0, needsYou: 1 }, pipeline: { conversationId: null, scope: "plan-task:T-1" }, planning: false,
        completedAt: null, subSessions: [sub], items: [{ id: uuid, title: "自己写的方案", status: "in_progress", dueDate: "2026-11-12", awaitingAcceptance: false,
          updatedAt: at }] }] }],
      other: { subSessions: [{ ...sub, kind: "topic", state: "queued", waiting: null, queueReason: "device_offline", sessionId: null, deviceId: null, autoStart: true }], items: [] },
      waiting: [{ id: `approval:${uuid}`, kind: "approval", title: "要运行命令", source: "修登录页 · 11/18 上线 V1", at, open: { kind: "card", id: uuid },
        taskId: "T-1", sessionId: uuid, deviceId: uuid, deviceName: "我的电脑", dueAt: null, answer: "inline_local", person: null, month: null },
      { id: "month:review:2026-10", kind: "month", title: "复盘 10 月", source: null, at, open: { kind: "month", id: "2026-10" }, taskId: null, sessionId: null,
        deviceId: null, deviceName: null, dueAt: at, answer: "open", person: null, month: { step: "review", period: "2026-10" } },
      { id: "acceptance:T-9:2", kind: "acceptance", title: "请你认可「交付」第 2 条", source: "陈创峰", at, open: { kind: "task_detail", id: "T-9" }, taskId: null,
        sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open", person: { personId: "p-2", name: "陈创峰" }, month: null }],
    };
    expect(Value.Check(WorkHomeResponse, home)).toBe(true);
    // 子会话只有卡和专题；规划员、验收员是后台任务。
    expect(Value.Check(WorkHomeResponse, { ...home, other: { items: [], subSessions: [{ ...sub, kind: "plan" }] } })).toBe(false);
    expect(Value.Check(WorkHomeResponse, { ...home, other: { items: [], subSessions: [{ ...sub, waiting: "paused" }] } })).toBe(false);
    // 之前月份的 Mission 带它的月份；验收过但没合回的子会话等你合。
    const merge = { state: "needs_merge", commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", at };
    expect(Value.Check(WorkHomeResponse, { ...home, missions: [...home.missions, { ...home.missions[0], missionId: "M0", period: "2026-10" }],
      other: { items: [], subSessions: [{ ...sub, state: "waiting", waiting: "merge", merge }] } })).toBe(true);
    expect(Value.Check(WorkHomeResponse, { ...home, missions: [{ ...home.missions[0], period: "10 月" }] })).toBe(false);
    expect(Value.Check(WorkHomeResponse, { ...home, other: { items: [], subSessions: [{ ...sub, state: "waiting", waiting: "merge",
      merge: { ...merge, reason: "not_ready", message: "卡还在跑" } }] } })).toBe(true);
  });

  it("Task 管线里的验收行：过了（带合回）、受阻、约定都达到、返工", () => {
    const merged = { state: "merged", commit: "abc1234", baseBranch: "main", reason: null, message: null, at };
    expect(Value.Check(TaskFeedResponse, { items: [
      { kind: "card_passed", id: `passed:${uuid}`, at, cardId: uuid, title: "greet", met: 5, total: 5, merge: merged },
      { kind: "card_blocked", id: `blocked:${uuid}`, at, cardId: uuid, title: "greet", handbackId: uuid, fix: "第 2 条：补测试" },
      { kind: "criteria_met", id: "criteria:T-1", at, met: 3, total: 3 },
      { kind: "rework_opened", id: `rework:${uuid}`, at, cardId: uuid, title: "返工：greet", fromCardId: uuid, reason: "返回值不对" },
    ] })).toBe(true);
    expect(Value.Check(TaskFeedResponse, { items: [{ kind: "card_merged", id: "x", at }] })).toBe(false);
  });

  it("后台任务：scope 只认 main、task、card、topic；条目带停哪个会话", () => {
    expect(Value.Check(BackgroundQuery, { scope: "main" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "task:T-A" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: `card:${uuid}` })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: `topic:${uuid}` })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "resources" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "all" })).toBe(false);
    expect(Value.Check(BackgroundQuery, { scope: "card:x" })).toBe(false);
    expect(Value.Check(BackgroundResponse, { resources, items: [{ id: `bg:${uuid}:t1`, title: "跑测试", kind: "command", state: "running", startedAt: at, finishedAt: null,
      stoppable: true, sessionId: uuid, itemId: "t1", deviceId: uuid, taskId: "T-1", cardId: uuid, topicId: null, holdUntil: null }] })).toBe(true);
  });

  it("Task 管线、自动分发、认领开工", () => {
    expect(Value.Check(TaskPipelineResponse, { taskId: "T-1", conversationId: uuid, scope: "plan-task:T-1" })).toBe(true);
    expect(Value.Check(RouteResponse, { target: "main" })).toBe(true);
    expect(Value.Check(RouteResponse, { target: { taskId: "T-1" } })).toBe(true);
    expect(Value.Check(RouteResponse, { target: "task" })).toBe(false);
    const start = { id: uuid, kind: "card", cardId: uuid, topicId: null, taskId: "T-1", requestedAt: at };
    expect(Value.Check(ClaimSessionStartsResponse, { starts: [{ ...start, budget: { mode: "set", hours: 2, weeklyPercent: null, money: { amount: 30, currency: "CNY" } } }] })).toBe(true);
    // 认领回执每条都带预算。
    expect(Value.Check(ClaimSessionStartsResponse, { starts: [start] })).toBe(false);
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
    for (const key of ["/api/me/work-home", "/api/me/background", "/api/me/tasks/{taskId}/pipeline", "/api/me/tasks/{taskId}/feed", "/api/me/route", "/api/me/session-starts/claim",
      "/api/me/session-starts/{id}/release"]) expect(paths[key]).toBeDefined();
  });
});
