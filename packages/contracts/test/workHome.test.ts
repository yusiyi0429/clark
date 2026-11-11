import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AcceptCardDraftsRequest, BackgroundQuery, BackgroundResponse, ClaimSessionStartsResponse, ConversationScope, CreateProjectRequest, ProjectDetailResponse,
  CardPlanBriefResponse, CardSplitRequestView, CreateProjectTransferRequest, ProjectBoardResponse, ProjectFeedResponse, ProjectPipelineResponse, ProjectTransfer, RouteResponse, UpdateProjectRequest, UpdateProjectTransferRequest, WorkHomeResponse,
  AutoRelayDecisionRequest, BuddyActionParams, MarkWorkSeenRequest, RegisterCardSplitRequest, SetGoalDueDateRequest, ClaimSessionCommandsResponse, PROJECT_ONLY_ACTIONS, SessionCommandDoneRequest, SUB_SESSION_REPORT_PREFIX,
} from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const uuid = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const at = "2026-11-07T08:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

const sub = { id: uuid, kind: "card", letter: "B", title: "修登录页", state: "waiting", unseen: false, waiting: "approval", queueReason: null, role: null, sessionId: uuid, deviceId: uuid,
  autoStart: false, updatedAt: at, merge: null, holdUntil: null };
const resources = { devices: [], running: 0, cap: null, cost: { today: { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null },
  month: { inputTokens: 0, outputTokens: 0, costUsd: null, costCny: null } }, quota: [{ deviceId: uuid, deviceName: "我的电脑", id: "claude", name: "Claude",
  kind: "subscription", remainingPercent: 0, amounts: [], resetsAt: at, windows: [{ kind: "weekly_all", model: null, usedPercent: 100, state: "blocked", resetsAt: at }], blockedUntil: at, updatedAt: at }] };

describe("新首页契约", () => {
  it("首页 v2：项目（目标、子会话、事项）、本月、其他、等你", () => {
    const goal = { taskId: "T-1", missionId: "M1", name: "11/18 上线 V1", period: "2026-11", dueDate: "2026-11-30", dueDateSource: "mission", criteria: ["登录能用", "首页能看", "能发消息"],
      criteriaMet: 1, criteriaTotal: 3, completedAt: null, responsible: null };
    const project = { projectId: uuid, name: "天枢新首页", goals: [goal], budget: null, lastActivityAt: at,
      summary: { running: 0, waiting: 1, queued: 0, done: 0, doneToday: 0, needsYou: 1 }, pipeline: { conversationId: null, scope: `project:${uuid}` }, planning: false,
      subSessions: [sub], items: [{ id: uuid, title: "自己写的方案", status: "in_progress", dueDate: "2026-11-12", awaitingAcceptance: false, updatedAt: at }], transfer: null, unseen: true };
    const home = {
      period: "2026-11",
      projects: [project, { ...project, name: "Chat 服务", goals: [], subSessions: [], items: [], budget: { state: "warning", percent: 82, taskId: "T-2" } }],
      archivedCount: 1,
      month: { missions: [{ missionId: "M1", title: "上线", period: "2026-11", tasks: [{ taskId: "T-1", name: "11/18 上线 V1", completedAt: null,
        project: { projectId: uuid, name: "天枢新首页" } }, { taskId: "T-3", name: "新的一件", completedAt: null, project: null }] }] },
      other: { subSessions: [{ ...sub, kind: "topic", state: "queued", waiting: null, queueReason: "device_offline", sessionId: null, deviceId: null, autoStart: true }], items: [] },
      waiting: [{ id: `approval:${uuid}`, kind: "approval", title: "要运行命令", source: "天枢新首页", at, open: { kind: "project", id: uuid, focus: { sessionId: uuid, requestId: "p-1" } },
        taskId: "T-1", projectId: uuid, sessionId: uuid, deviceId: uuid, deviceName: "我的电脑", letter: "B", dueAt: null, answer: "inline_local", person: null, month: null, question: null,
        permission: { requestId: "p-1", toolName: "Bash", title: "要运行命令", outsidePaths: [] } },
      { id: `question:${uuid}`, kind: "question", title: "先做哪一页？", source: null, at, open: { kind: "topic", id: uuid }, taskId: null, projectId: null, sessionId: uuid,
        deviceId: uuid, deviceName: "我的电脑", letter: "B", dueAt: null, answer: "inline_local", person: null, month: null, permission: null,
        question: { requestId: "q-1", askedAt: at, questions: [{ question: "先做哪一页？", header: "顺序", multiSelect: false, options: [{ label: "登录页", description: "" }] }] } },
      { id: "acceptance:T-9:2", kind: "acceptance", title: "请你认可「交付」第 2 条", source: "陈创峰", at, open: { kind: "task_detail", id: "T-9" }, taskId: null, projectId: null,
        sessionId: null, deviceId: null, deviceName: null, letter: null, dueAt: null, answer: "open", person: { personId: "p-2", name: "陈创峰" }, month: null, question: null, permission: null }],
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
    const project = { projectId: uuid, name: "天枢新首页", archivedAt: null, createdAt: at, lastActivityAt: null, transfer: null, permissionMode: "auto", autoRelayLimit: 20 };
    // 新开子会话的默认权限模式：五档之一，项目设置里改。
    expect(Value.Check(UpdateProjectRequest, { permissionMode: "plan" })).toBe(true);
    expect(Value.Check(UpdateProjectRequest, { permissionMode: "yolo" })).toBe(false);
    expect(Value.Check(ProjectDetailResponse, { project, period: "2026-11", goals: [
      { taskId: "T-1", taskName: "11/18 上线 V1", missionId: "M1", missionTitle: "上线", period: "2026-11", verdict: "open", source: "auto", linkedAt: at, dueDate: "2026-11-18" },
      { taskId: "T-0", taskName: "内部版跑通", missionId: "M0", missionTitle: null, period: "2026-10", verdict: "continued", source: "migration", linkedAt: at, dueDate: null },
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
      clone: { repoUrl: "https://github.com/x/y.git", branch: "main" }, afterSequence: 12 };
    expect(Value.Check(ProjectTransfer, transfer)).toBe(true);
    // 转交卡排在项目对话哪条消息后面（项目对话的消息不带时间）；对话还没消息时为 null。
    expect(Value.Check(ProjectTransfer, { ...transfer, afterSequence: null })).toBe(true);
    expect(Value.Check(CreateProjectTransferRequest, { toPersonId: "p-晨星", afterSequence: 12 })).toBe(true);
    expect(Value.Check(CreateProjectTransferRequest, { toPersonId: "p-晨星", afterSequence: 0 })).toBe(false);
    expect(Value.Check(ProjectTransfer, { ...transfer, status: "draft" })).toBe(false);
    // 本机 clone 不认的地址（本地路径、file://）云端给 null，不给网页一个点了才报错的地址。
    expect(Value.Check(ProjectTransfer, { ...transfer, clone: { repoUrl: "file:///D:/code/y", branch: null } })).toBe(false);
    expect(Value.Check(ProjectTransfer, { ...transfer, clone: { repoUrl: "git@github.com:x/y.git", branch: "handover/chat" } })).toBe(true);
    expect(Value.Check(UpdateProjectTransferRequest, { includeHistory: true })).toBe(true);
    expect(Value.Check(UpdateProjectTransferRequest, { checkResult: check, check: "wait" })).toBe(true);
    expect(Value.Check(UpdateProjectTransferRequest, {})).toBe(false);
    const waiting = { id: `transfer:${uuid}`, kind: "transfer", title: "人豪把「Chat 服务」交给你", source: null, at, open: { kind: "transfer", id: uuid }, taskId: null,
      projectId: uuid, sessionId: null, deviceId: null, deviceName: null, letter: null, dueAt: null, answer: "open", person: person("人豪"), month: null, question: null, permission: null };
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
      sourceWords: ["把首页改成按项目排"], createdAt: at, afterSequence: 12 })).toBe(true);
    expect(Value.Check(CardSplitRequestView, { id: uuid, taskId: "T-1", taskName: "上线", missionId: "M1", projectId: null, projectName: null, origin: "buddy",
      sourceWords: [], createdAt: at, afterSequence: null })).toBe(true);
    expect(Value.Check(CardPlanBriefResponse, { markdown: "# 拆卡：Chat 服务", role: null, task: null, project: { projectId: uuid, name: "Chat 服务" }, criteria: [],
      exclusions: [], roles: [], sourceWords: ["把首页改成按项目排"] })).toBe(true);
    expect(Value.Check(ProjectBoardResponse, { projectId: uuid, cards: [], drafts: [{ id: uuid, planId: uuid, position: 0, title: "接网关", brief: "做什么",
      doneDefinition: "能连上；有日志", criterionIndex: null, role: null, suggestPresetKey: null, executor: "claude_code", modelTier: "normal", why: null, sourceWords: ["接上网关"] }], plan: null })).toBe(true);
    // 17.2 第 29 条：派活单和「开了哪几个子会话」按序号插进项目对话；登记、放进看板时网页带上本人看到的最后一条。
    expect(Value.Check(ProjectBoardResponse, { projectId: uuid, cards: [], drafts: [], plan: { id: uuid, status: "done", hint: null, error: null, createdAt: at,
      startedAt: null, finishedAt: at, expectedSeconds: 60, source: "local", summary: "拆成三件", steps: [], risks: [], revision: 1, afterSequence: 12,
      startedAfterSequence: null } })).toBe(true);
    expect(Value.Check(RegisterCardSplitRequest, { words: "先拆登录", afterSequence: 12 })).toBe(true);
    expect(Value.Check(RegisterCardSplitRequest, { afterSequence: 0 })).toBe(false);
    expect(Value.Check(AcceptCardDraftsRequest, { drafts: [{ id: uuid }], start: true, afterSequence: 15 })).toBe(true);
  });

  it("自动分发到项目、认领开工带项目", () => {
    expect(Value.Check(RouteResponse, { target: "main" })).toBe(true);
    expect(Value.Check(RouteResponse, { target: { projectId: uuid } })).toBe(true);
    expect(Value.Check(RouteResponse, { target: { taskId: "T-1" } })).toBe(false);
    const start = { id: uuid, kind: "card", cardId: uuid, topicId: null, taskId: "T-1", projectId: uuid, requestedAt: at };
    expect(Value.Check(ClaimSessionStartsResponse, { starts: [{ ...start, budget: { mode: "set", hours: 2, weeklyPercent: null, money: { amount: 30, currency: "CNY" } },
      permissionMode: "acceptEdits" }] })).toBe(true);
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
  it("子会话用字母、停了和要介入报进项目对话、项目主管线按字母管子会话（18 节第 10 条）", () => {
    const sub = { kind: "card", id: uuid, letter: "AB", title: "修登录页" };
    const question = { requestId: "q-1", questions: [{ question: "用哪个库？", header: "库", options: [{ label: "A", description: "" }], multiSelect: false }], askedAt: at };
    expect(Value.Check(ProjectFeedResponse, { items: [
      { kind: "sub_session_report", id: uuid, at, afterSequence: 12, sub, why: "turn_done", summary: "登录页改完了，测试过了。", blocker: null,
        outputs: [{ outputId: uuid, title: "改动说明", fileName: "改动说明.md" }, { outputId: null, title: "截图", fileName: "登录页.png" }] },
      { kind: "sub_session_report", id: uuid, at, afterSequence: null, sub, why: "held", summary: null, blocker: "订阅额度用完，14:00 恢复", outputs: [] },
      { kind: "sub_session_decision", id: uuid, at, afterSequence: 13, sub, sessionId: uuid, deviceId: uuid, question, permission: null, status: "open", closedAt: null },
    ] })).toBe(true);
    // 字母只能是大写字母，最多三位。
    for (const letter of ["a", "", "ABCD", "B1"]) expect(Value.Check(ProjectFeedResponse, { items: [
      { kind: "sub_session_report", id: uuid, at, afterSequence: null, sub: { ...sub, letter }, why: "killed", summary: null, blocker: null, outputs: [] }] })).toBe(false);
    expect(SUB_SESSION_REPORT_PREFIX).toBe("【子会话回报】");
    expect(Value.Check(ClaimSessionCommandsResponse, { commands: [
      { id: uuid, kind: "card", subSessionId: uuid, sessionId: uuid, deviceId: uuid, requestedAt: at, command: { type: "message", text: "先停在测试这步" } },
      { id: uuid, kind: "topic", subSessionId: uuid, sessionId: uuid, deviceId: uuid, requestedAt: at,
        command: { type: "answer", requestId: "q-1", answer: { choices: [["A"]] } } },
      { id: uuid, kind: "card", subSessionId: uuid, sessionId: uuid, deviceId: uuid, requestedAt: at,
        command: { type: "permission", requestId: "p-1", decision: { decision: "allow" } } },
    ] })).toBe(true);
    expect(Value.Check(SessionCommandDoneRequest, { deviceId: uuid, result: "expired" })).toBe(true);
    expect(Value.Check(BuddyActionParams.sub_session_approve, { letter: "B", decision: "allow", allowForSession: true })).toBe(true);
    expect(Value.Check(BuddyActionParams.sub_session_answer, { letter: "C", choices: [["第二个"]] })).toBe(true);
    expect(Value.Check(BuddyActionParams.sub_session_tell, { letter: "b", text: "停一下" })).toBe(false);
    expect([...PROJECT_ONLY_ACTIONS]).toEqual(["sub_session_tell", "sub_session_stop", "sub_session_restart", "sub_session_answer", "sub_session_approve", "update_card"]);
    const paths = buildOpenApiDocument().paths!;
    expect(paths["/api/me/session-commands/claim"]).toBeDefined();
    // 18 节第 12 条：自动接力的上限在项目设置里，null 不限；「等你」里 auto_relay 就地继续或停下。
    expect(Value.Check(UpdateProjectRequest, { autoRelayLimit: 20 })).toBe(true);
    expect(Value.Check(UpdateProjectRequest, { autoRelayLimit: null })).toBe(true);
    expect(Value.Check(UpdateProjectRequest, { autoRelayLimit: 0 })).toBe(false);
    expect(Value.Check(AutoRelayDecisionRequest, { decision: "continue" })).toBe(true);
    expect(Value.Check(AutoRelayDecisionRequest, { decision: "later" })).toBe(false);
    expect(paths["/api/me/projects/{projectId}/auto-relay"]).toBeDefined();
    // Task 截止日：天枢里存的（null 不存了），首页目标带来源。
    expect(Value.Check(SetGoalDueDateRequest, { dueDate: "2026-11-18" })).toBe(true);
    expect(Value.Check(SetGoalDueDateRequest, { dueDate: null })).toBe(true);
    expect(Value.Check(SetGoalDueDateRequest, { dueDate: "11/18" })).toBe(false);
    expect(Value.Check(BuddyActionParams.set_task_due_date, { projectId: uuid, taskId: "T-1", dueDate: "2026-11-30" })).toBe(true);
    expect(paths["/api/me/projects/{projectId}/goals/{taskId}/due-date"]).toBeDefined();
    // 蓝点（17.2 第 25 条）：打开子会话或项目对话记看过。
    expect(Value.Check(MarkWorkSeenRequest, { kind: "sub", id: uuid })).toBe(true);
    expect(Value.Check(MarkWorkSeenRequest, { kind: "card", id: uuid })).toBe(false);
    expect(paths["/api/me/work-seen"]).toBeDefined();
    expect(paths["/api/me/session-commands/{id}/done"]).toBeDefined();
  });
});
