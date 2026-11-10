import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LOCAL_PROJECT_SESSION_ROUTES, LocalProjectSessionEvent, LocalProjectSessionResponse, LocalProjectSessionStopResponse, LocalProjectSessionTurnRequest,
  LocalProjectSessionTurnResponse, LocalSessionEvent,
} from "../src/index.js";

const projectId = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const sessionId = "0d2f9a1e-7c44-4b5e-8f3a-2a9e6c1d7b55";
const turnId = "3c1b7e90-5a2d-4f68-9b0c-8d7e6f5a4b3c";
const clientTurnId = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const at = "2026-11-10T04:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

const session = {
  projectId, sessionId, agent: "codex", modelProfileId: "codex-gpt-6_1-sol", modelLabel: "GPT-6.1-Sol", cwd: "C:/work/repo",
  status: "running", turn: { turnId, clientTurnId, message: "把登录页拆成卡", startedAt: at, startSeq: 41 }, lastSeq: 44, updatedAt: at,
};

describe("本机的项目会话（网页 ↔ 本机）", () => {
  it("路由：读项目会话、交一句、停下、读事件流，都按项目 id", () => {
    expect(LOCAL_PROJECT_SESSION_ROUTES.getProjectSession).toEqual({ method: "GET", path: "/v1/project-sessions/:projectId", auth: true });
    expect(LOCAL_PROJECT_SESSION_ROUTES.startProjectTurn).toEqual({ method: "POST", path: "/v1/project-sessions/:projectId/turns", auth: true });
    expect(LOCAL_PROJECT_SESSION_ROUTES.stopProjectTurn).toEqual({ method: "POST", path: "/v1/project-sessions/:projectId/stop", auth: true });
    expect(LOCAL_PROJECT_SESSION_ROUTES.projectSessionEvents).toEqual({ method: "GET", path: "/v1/project-sessions/:projectId/events", auth: true });
  });

  it("项目会话：还没在本机跑过为 null；在跑时带着这一轮和从哪条事件读起", () => {
    expect(Value.Check(LocalProjectSessionResponse, { session: null })).toBe(true);
    expect(Value.Check(LocalProjectSessionResponse, { session })).toBe(true);
    expect(Value.Check(LocalProjectSessionResponse, { session: { ...session, status: "idle", turn: null, effort: "high" } })).toBe(true);
    expect(Value.Check(LocalProjectSessionResponse, { session: { ...session, status: "queued" } })).toBe(false); // 项目会话不排队
    expect(Value.Check(LocalProjectSessionResponse, { session: { ...session, status: "waiting_permission" } })).toBe(false); // 也不来问批准
    expect(Value.Check(LocalProjectSessionStopResponse, { session: { ...session, status: "idle", turn: null } })).toBe(true);
  });

  it("交一句：带网页起的号；能带回答的是哪个选项框、从这一轮起用哪个模型（另一家的就是换执行方）", () => {
    expect(Value.Check(LocalProjectSessionTurnRequest, { clientTurnId, message: "把登录页拆成卡" })).toBe(true);
    expect(Value.Check(LocalProjectSessionTurnRequest, { clientTurnId, message: "只发预发", buddyQuestionId: turnId, modelProfileId: "subscription", effort: null })).toBe(true);
    expect(Value.Check(LocalProjectSessionTurnRequest, { message: "没有号" })).toBe(false);
    expect(Value.Check(LocalProjectSessionTurnRequest, { clientTurnId, message: "" })).toBe(false);
    expect(Value.Check(LocalProjectSessionTurnRequest, { clientTurnId, message: "x", agent: "codex" })).toBe(false); // 执行方跟着模型配置走，不单独带
  });

  it("三种结果：本机接下了；没跑成改发云端（带原因）；别处有一轮在跑", () => {
    expect(Value.Check(LocalProjectSessionTurnResponse, { outcome: "started", turnId, session })).toBe(true);
    expect(Value.Check(LocalProjectSessionTurnResponse, { outcome: "cloud", reason: "local_quota", message: "Codex 订阅额度用完了" })).toBe(true);
    expect(Value.Check(LocalProjectSessionTurnResponse, { outcome: "cloud", reason: "local_unavailable", message: "Codex 还没登录" })).toBe(true);
    expect(Value.Check(LocalProjectSessionTurnResponse, { outcome: "cloud", reason: "busy", message: "x" })).toBe(false);
    expect(Value.Check(LocalProjectSessionTurnResponse, { outcome: "busy", runningOn: "cloud", message: "这个项目对话正在云端回答上一句" })).toBe(true);
    expect(Value.Check(LocalProjectSessionTurnResponse, { outcome: "started", turnId })).toBe(false);
  });

  it("事件流：子会话的那几种照用，再加这一轮的开始、结束、报给天枢的结果、出的卡、界面要跟着变的", () => {
    const base = { at, sessionId };
    const ok = (e: Record<string, unknown>) => Value.Check(LocalProjectSessionEvent, { ...base, ...e });
    expect(ok({ seq: 41, type: "project_turn_start", turnId, clientTurnId })).toBe(true);
    expect(ok({ seq: 42, type: "user_message", text: "把登录页拆成卡", source: "web", messageId: clientTurnId })).toBe(true);
    expect(ok({ seq: 43, type: "tool_call", toolUseId: "t1", name: "mcp__tianshu__split_cards", title: "tianshu · split_cards", input: {} })).toBe(true);
    expect(ok({ seq: 44, type: "plan", entries: [{ content: "拆卡", status: "in_progress" }], progress: { done: 0, total: 1, step: 1, current: "拆卡" } })).toBe(true);
    expect(ok({ seq: 45, type: "project_card", turnId, card: { kind: "buddy_question", questionId: turnId, status: "open",
      questions: [{ header: "发布", question: "发到哪？", options: [{ label: "只发预发", detail: "先在预发看一遍", recommended: true }, { label: "直接上线", detail: "跳过预发" }] }] } })).toBe(true);
    expect(ok({ seq: 46, type: "project_ui", turnId, ui: { kind: "refresh", what: ["work_home", "project"], id: projectId } })).toBe(true);
    expect(ok({ seq: 47, type: "project_turn_end", turnId, status: "completed" })).toBe(true);
    expect(ok({ seq: 47, type: "project_turn_end", turnId, status: "failed", errorCode: "api" })).toBe(true);
    expect(ok({ seq: 47, type: "project_turn_end", turnId, status: "released", reason: "local_quota" })).toBe(true);
    expect(ok({ seq: 47, type: "project_turn_end", turnId, status: "expired" })).toBe(false);
    expect(ok({ seq: 48, type: "project_turn_synced", turnId, state: "recorded" })).toBe(true);
    expect(ok({ seq: 48, type: "project_turn_synced", turnId, state: "lost" })).toBe(true);
    expect(ok({ seq: 49, type: "notice", level: "info", code: "harness_changed", text: "换成 Claude Code · 我的 Claude 订阅 · 思考 medium" })).toBe(true);
    // 子会话自己的事件流不认项目会话的这几种
    expect(Value.Check(LocalSessionEvent, { ...base, seq: 41, type: "project_turn_start", turnId, clientTurnId })).toBe(false);
  });
});
