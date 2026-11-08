import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AcceptCardDraftsRequest, BackgroundQuery, BackgroundResponse, ClaimSessionStartsResponse, ConversationScope, CreateProjectRequest, ProjectDetailResponse,
  CardPlanBriefResponse, CardSplitRequestView, ProjectBoardResponse, ProjectFeedResponse, ProjectPipelineResponse, ProjectTransfer, RouteResponse, UpdateProjectRequest, UpdateProjectTransferRequest, WorkHomeResponse,
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
  month: { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null } }, quota: [{ deviceId: uuid, deviceName: "我的电脑", id: "claude", name: "Claude",
  kind: "subscription", remainingPercent: 0, amounts: [], resetsAt: at, windows: [{ kind: "weekly_all", model: null, usedPercent: 100, state: "blocked", resetsAt: at }], blockedUntil: at, updatedAt: at }] };

describe("新首页契约", () => {
  it("首页 v2：项目（目标、子会话、事项）、本月、其他、等你", () => {
    const goal = { taskId: "T-1", missionId: "M1", name: "11/18 上线 V1", period: "2026-11", dueDate: "2026-11-30", criteria: ["登录能用", "首页能看", "能发消息"],
      criteriaMet: 1, criteriaTotal: 3, completedAt: null, responsible: null };
    const project = { projectId: uuid, name: "天枢新首页", goals: [goal], budget: null, lastActivityAt: at,
      summary: { running: 0, waiting: 1, queued: 0, done: 0, doneToday: 0, needsYou: 1 }, pipeline: { conversationId: null, scope: `project:${uuid}` }, planning: false,
      subSessions: [sub], items: [{ id: uuid, title: "自己写的方案", status: "in_progress", dueDate: "2026-11-12", awaitingAcceptance: false, updatedAt: at }], transfer: null };
    const home = {
      period: "2026-11",
      projects: [project, { ...project, name: "Chat 服务", goals: [], subSessions: [], items: [], budget: { state: "warning", percent: 82, taskId: "T-2" } }],
      archivedCount: 1,
      month: { missions: [{ missionId: "M1", title: "上线", period: "2026-11", tasks: [{ taskId: "T-1", name: "11/18 上线 V1", completedAt: null,
        project: { projectId: uuid, name: "天枢新首页" } }, { taskId: "T-3", name: "新的一件", completedAt: null, project: null }] }] },
      other: { subSessions: [{ ...sub, kind: "topic", state: "queued", waiting: null, queueReason: "device_offline", sessionId: null, deviceId: null, autoStart: true }], items: [] },
      waiting: [{ id: `approval:${uuid}`, kind: "approval", title: "要运行命令", source: "天枢新首页", at, open: { kind: "project", id: uuid, focus: { sessionId: uuid, requestId: "p-1" } },
        taskId: "T-1", projectId: uuid, sessionId: uuid, deviceId: uuid, deviceName: "我的电脑", dueAt: null, answer: "inline_local", person: null, month: null, question: null,
        permission: { requestId: "p-1", toolName: "Bash", title: "要运行命令", outsidePaths: [] } },
      { id: `question:${uuid}`, kind: "question", title: "先做哪一页？", source: null, at, open: { kind: "topic", id: uuid }, taskId: null, projectId: null, sessionId: uuid,
        deviceId: uuid, deviceName: "我的电脑", dueAt: null, answer: "inline_local", person: null, month: null, permission: null,
        question: { requestId: "q-1", askedAt: at, questions: [{ question: "先做哪一页？", header: "顺序", multiSelect: false, options: [{ label: "登录页", description: "" }] }] } },
      { id: "acceptance:T-9:2", kind: "acceptance", title: "请你认可「交付」第 2 条", source: "陈创峰", at, open: { kind: "task_detail", id: "T-9" }, taskId: null, projectId: null,
        sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open", person: { personId: "p-2", name: "陈创峰" }, month: null, question: null, permission: null }],
    };
    expect(Value.Check(WorkHomeResponse, home)).toBe(true);
    // 子会话只有卡和专题；规划员、验收员是后台任务。
    expect(Value.Check(WorkHomeResponse, { ...home, other: { items: [], subSessions: [{ ...sub, kind: "plan" }] } })).toBe(false);
    // 原来的 Task 管线没有了：等你不再指向 task，首页不再有 missions 树。
    expect(Value.Check(WorkHomeResponse, { ...home, waiting: [{ ...home.waiting[0], open: { kind: "task", id: "T-1" } }] })).toBe(false);
    expect(Value.Check(WorkHomeResponse, { ...home, missions: [] })).toBe(false);
    expect(Value.Check(WorkHomeResponse, { ...home, projects: [{ ...project, goals: [{ ...goal, dueDate: "11 月底" }] }] })).toBe(false);
    // 验收过但没合回的子会话等你合。
    const merge = { state: "needs_merge", commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", at };
    expect(Value.Check(WorkHomeResponse, { ...home, other: { items: [], subSessions: [{ ...sub, state: "waiting", waiting: "merge", merge }] } })).toBe(true);
  });

  it("项目：建、改名归档、详情的目标历史、项目对话、动态里的分隔线和验收行", () => {
    expect(Value.Check(CreateProjectRequest, { name: "天枢新首页" })).toBe(true);
    expect(Value.Check(CreateProjectRequest, { name: "天枢新首页", taskId: "T-1" })).toBe(true);
    expect(Value.Check(CreateProjectRequest, { name: "" })).toBe(false);
    expect(Value.Check(UpdateProjectRequest, { archived: true })).toBe(true);
    expect(Value.Check(UpdateProjectRequest, {})).toBe(false);
    const project = { projectId: uuid, name: "天枢新首页", archivedAt: null, createdAt: at, lastActivityAt: null, transfer: null };
    expect(Value.Check(ProjectDetailResponse, { project, period: "2026-11", goals: [
      { taskId: "T-1", taskName: "11/18 上线 V1", missionId: "M1", missionTitle: "上线", period: "2026-11", verdict: "open", source: "auto", linkedAt: at },
      { taskId: "T-0", taskName: "内部版跑通", missionId: "M0", missionTitle: null, period: "2026-10", verdict: "continued", source: "migration", linkedAt: at },
    ] })).toBe(true);
    expect(Value.Check(ProjectPipelineResponse, { projectId: uuid, conversationId: uuid, scope: `project:${uuid}` })).toBe(true);
    const merged = { state: "merged", commit: "abc1234", baseBranch: "main", reason: null, message: null, at };
    expect(Value.Check(ProjectFeedResponse, { items: [
      { kind: "goal_linked", id: `goal:T-1`, at, period: "2026-11", taskId: "T-1", taskName: "11/18 上线 V1" },
      { kind: "card_passed", id: `passed:${uuid}`, at, cardId: uuid, title: "greet", met: 5, total: 5, merge: merged },
      { kind: "card_blocked", id: `blocked:${uuid}`, at, cardId: uuid, title: "greet", handbackId: uuid, fix: "第 2 条：补测试", sourceWordIssues: [{ quote: "录屏这次先不做", kind: "extra", reason: "做了录屏" }] },
      { kind: "criteria_met", id: "criteria:T-1:3", at, taskId: "T-1", met: 3, total: 3 },
      { kind: "rework_opened", id: `rework:${uuid}`, at, cardId: uuid, title: "返工：greet", fromCardId: uuid, reason: "返回值不对" },
    ] })).toBe(true);
    expect(Value.Check(ProjectFeedResponse, { items: [{ kind: "card_merged", id: "x", at }] })).toBe(false);
  });

  it("后台任务：scope 只认 main、project、task、card、topic；条目带停哪个会话", () => {
    expect(Value.Check(BackgroundQuery, { scope: "main" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: `project:${uuid}` })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "project:x" })).toBe(false);
    expect(Value.Check(BackgroundQuery, { scope: "task:T-A" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: `card:${uuid}` })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: `topic:${uuid}` })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "resources" })).toBe(true);
    expect(Value.Check(BackgroundQuery, { scope: "all" })).toBe(false);
    expect(Value.Check(BackgroundQuery, { scope: "card:x" })).toBe(false);
    expect(Value.Check(BackgroundResponse, { resources, items: [{ id: `bg:${uuid}:t1`, title: "跑测试", kind: "command", state: "running", startedAt: at, finishedAt: null,
      stoppable: true, sessionId: uuid, itemId: "t1", deviceId: uuid, taskId: "T-1", cardId: uuid, topicId: null, holdUntil: null }] })).toBe(true);
  });

  it("项目转交（16.7）：转交的形状同网页、本机检查结果原样、等你里的 transfer、动态里的换人分隔线和交接说明", () => {
    const person = (name: string) => ({ personId: `p-${name}`, name });
    const check = { projectId: uuid, checkedAt: at, folder: { path: "D:/code/tianshu", label: "tianshu" }, git: { branch: "main",
      remotes: [{ name: "origin", url: "https://github.com/x/y.git" }], uncommitted: ["a.ts"], uncommittedCount: 1, unpushed: [] }, recentFiles: null };
    const transfer = { id: uuid, projectId: uuid, projectName: "Chat 服务", from: person("人豪"), to: person("晨星"), status: "sent", startedAt: at, decidedAt: at,
      includeHistory: false, running: "wait", check: "wait", note: [{ title: "到哪了", lines: ["11 月目标：上线 · 11/30 验收"] }], checkResult: check,
      clone: { repoUrl: "https://github.com/x/y.git", branch: "main" } };
    expect(Value.Check(ProjectTransfer, transfer)).toBe(true);
    expect(Value.Check(ProjectTransfer, { ...transfer, status: "draft" })).toBe(false);
    // 本机 clone 不认的地址（本地路径、file://）云端给 null，不给网页一个点了才报错的地址。
    expect(Value.Check(ProjectTransfer, { ...transfer, clone: { repoUrl: "file:///D:/code/y", branch: null } })).toBe(false);
    expect(Value.Check(ProjectTransfer, { ...transfer, clone: { repoUrl: "git@github.com:x/y.git", branch: "handover/chat" } })).toBe(true);
    expect(Value.Check(UpdateProjectTransferRequest, { includeHistory: true })).toBe(true);
    expect(Value.Check(UpdateProjectTransferRequest, { checkResult: check, check: "wait" })).toBe(true);
    expect(Value.Check(UpdateProjectTransferRequest, {})).toBe(false);
    const waiting = { id: `transfer:${uuid}`, kind: "transfer", title: "人豪把「Chat 服务」交给你", source: null, at, open: { kind: "transfer", id: uuid }, taskId: null,
      projectId: uuid, sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open", person: person("人豪"), month: null, question: null, permission: null };
    expect(Value.Check(WorkHomeResponse, { period: "2026-11", projects: [], archivedCount: 0, month: { missions: [] }, other: { subSessions: [], items: [] },
      waiting: [waiting] })).toBe(true);
    expect(Value.Check(ProjectFeedResponse, { items: [
      { kind: "handover", id: `handover:${uuid}`, at, transferId: uuid, from: person("人豪"), to: person("晨星") },
      { kind: "handover_summary", id: `summary:${uuid}`, at, transferId: uuid, from: person("人豪"), note: transfer.note },
      { kind: "transfer_declined", id: `declined:${uuid}`, at, transferId: uuid, by: person("晨星") },
    ] })).toBe(true);
  });

  it("没挂 Task 的项目也能拆卡（16.3）：登记、交代、项目看板", () => {
    expect(Value.Check(CardSplitRequestView, { id: uuid, taskId: null, taskName: null, missionId: null, projectId: uuid, projectName: "Chat 服务", origin: "web",
      sourceWords: ["把首页改成按项目排"], createdAt: at })).toBe(true);
    expect(Value.Check(CardSplitRequestView, { id: uuid, taskId: "T-1", taskName: "上线", missionId: "M1", projectId: null, projectName: null, origin: "buddy",
      sourceWords: [], createdAt: at })).toBe(true);
    expect(Value.Check(CardPlanBriefResponse, { markdown: "# 拆卡：Chat 服务", role: null, task: null, project: { projectId: uuid, name: "Chat 服务" }, criteria: [],
      exclusions: [], roles: [], sourceWords: ["把首页改成按项目排"] })).toBe(true);
    expect(Value.Check(ProjectBoardResponse, { projectId: uuid, cards: [], drafts: [{ id: uuid, planId: uuid, position: 0, title: "接网关", brief: "做什么",
      doneDefinition: "能连上；有日志", criterionIndex: null, role: null, suggestPresetKey: null, executor: "claude_code", modelTier: "normal", why: null, sourceWords: ["接上网关"] }], plan: null })).toBe(true);
  });

  it("自动分发到项目、认领开工带项目", () => {
    expect(Value.Check(RouteResponse, { target: "main" })).toBe(true);
    expect(Value.Check(RouteResponse, { target: { projectId: uuid } })).toBe(true);
    expect(Value.Check(RouteResponse, { target: { taskId: "T-1" } })).toBe(false);
    const start = { id: uuid, kind: "card", cardId: uuid, topicId: null, taskId: "T-1", projectId: uuid, requestedAt: at };
    expect(Value.Check(ClaimSessionStartsResponse, { starts: [{ ...start, budget: { mode: "set", hours: 2, weeklyPercent: null, money: { amount: 30, currency: "CNY" } } }] })).toBe(true);
    // 认领回执每条都带预算。
    expect(Value.Check(ClaimSessionStartsResponse, { starts: [start] })).toBe(false);
    expect(Value.Check(AcceptCardDraftsRequest, { drafts: [{ id: uuid }], start: true })).toBe(true);
  });

  it("对话 scope 认项目对话 project:<projectId>，不再认 plan-task", () => {
    expect(Value.Check(ConversationScope, `project:${uuid}`)).toBe(true);
    expect(Value.Check(ConversationScope, "project:T-A")).toBe(false);
    expect(Value.Check(ConversationScope, "plan-task:T-A")).toBe(false);
    expect(Value.Check(ConversationScope, "global")).toBe(true);
  });

  it("OpenAPI 里列了新首页的路径", () => {
    const paths = buildOpenApiDocument().paths;
    for (const key of ["/api/me/work-home", "/api/me/background", "/api/me/projects", "/api/me/projects/{projectId}", "/api/me/projects/{projectId}/goals/{taskId}",
      "/api/me/projects/{projectId}/pipeline", "/api/me/projects/{projectId}/feed", "/api/me/route", "/api/me/session-starts/claim",
      "/api/me/session-starts/{id}/release", "/api/me/projects/{projectId}/transfers", "/api/me/project-transfers/{id}", "/api/me/project-transfers/{id}/send",
      "/api/me/project-transfers/{id}/withdraw", "/api/me/project-transfers/{id}/accept", "/api/me/project-transfers/{id}/decline",
      "/api/me/project-transfers/{id}/history", "/api/me/sub-sessions/{kind}/{id}/start", "/api/me/projects/{projectId}/board", "/api/me/projects/{projectId}/card-splits",
      "/api/me/projects/{projectId}/plan-brief", "/api/me/projects/{projectId}/card-drafts/accept"]) expect(paths[key]).toBeDefined();
    expect(paths["/api/me/tasks/{taskId}/pipeline"]).toBeUndefined();
  });
});
