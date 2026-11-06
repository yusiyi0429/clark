import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LocalCreateSessionRequest, LocalModelProfileUpsert, LocalModelProfile, LocalPermissionDecisionRequest, LocalSessionEvent,
  LocalSyncBatchRequest, LocalPairingStatusResponse, LocalSendMessageRequest, LOCAL_RUNNER_ROUTES,
  LocalCreateSessionBatchRequest, LocalCreateSessionBatchResponse, LocalSettingsPatch, LocalSessionSummary, LocalHealthResponse,
  LocalVerifyBriefResponse, LOCAL_RUNNER_VERIFY_BRIEF_PATH,
} from "../src/index.js";

const sessionId = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const deviceId = "0d2f9a1e-7c44-4b5e-8f3a-2a9e6c1d7b55";

// 本机程序运行时自己注册这两种格式；这里只为 Value.Check 局部注册。
beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

describe("本机程序契约", () => {
  it("开会话：卡要有 cardId 的位置，专题可以不给目录", () => {
    expect(Value.Check(LocalCreateSessionRequest, {
      subject: { kind: "card", cardId: "task-1" }, title: "修登录页", cwd: "C:/work/repo", modelProfileId: "subscription", firstMessage: "开始",
    })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "topic", topicId: "t-1" }, title: "比较日志存储", firstMessage: "先出提纲" })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "card" }, title: "x", firstMessage: "" })).toBe(false);
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "card" }, title: "x", firstMessage: "y", env: { A: "1" } })).toBe(false);
  });

  it("开工带岗位（和云端的 RoleBrief 同形，可原样转）；专题带挑刺岗位；说一句可以是评审会", () => {
    const role = { id: sessionId, name: "调研员", kind: "worker", dutiesMd: "职责", practiceMd: "做法", acceptanceMd: "口径", tools: ["web_search", "feishu"], modelTier: "normal", version: 2 };
    const critic = { ...role, name: "反方", kind: "critic", tools: [] };
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "topic", topicId: "t-1" }, title: "x", firstMessage: "y", role, critics: [critic, critic], versionBase: 2 })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "topic", topicId: "t-1" }, title: "x", firstMessage: "y", critics: [critic, critic, critic, critic] })).toBe(false);
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "card", cardId: "c" }, title: "x", firstMessage: "y", role: { ...role, tools: ["shell"] } })).toBe(false);
    expect(Value.Check(LocalSendMessageRequest, { kind: "review" })).toBe(true);
    expect(Value.Check(LocalSendMessageRequest, { kind: "review", text: "重点看数据" })).toBe(true);
    expect(Value.Check(LocalSendMessageRequest, { kind: "vote", text: "x" })).toBe(false);
  });

  it("模型钥匙只写不读", () => {
    expect(Value.Check(LocalModelProfileUpsert, { label: "TokenHub DeepSeek", source: "gateway", baseUrl: "https://hub.example.com", model: "deepseek", apiKey: "k" })).toBe(true);
    expect(Value.Check(LocalModelProfileUpsert, { label: "x", source: "gateway", baseUrl: "file:///etc", model: "m" })).toBe(false);
    expect(Value.Check(LocalModelProfileUpsert, { label: "x", source: "gateway", baseUrl: "https://hub.example.com", model: "m", apiKey: "sk\nadd-generic-password" })).toBe(false);
    expect(LocalModelProfile.properties).not.toHaveProperty("apiKey");
    expect(LocalModelProfile.properties).toHaveProperty("hasKey");
  });

  it("权限决定可附理由、可本会话都允许", () => {
    expect(Value.Check(LocalPermissionDecisionRequest, { decision: "deny", message: "别改这个文件" })).toBe(true);
    expect(Value.Check(LocalPermissionDecisionRequest, { decision: "allow", allowForSession: true })).toBe(true);
    expect(Value.Check(LocalPermissionDecisionRequest, { decision: "maybe" })).toBe(false);
  });

  it("事件带序号、会话和类型，类型之外的字段拒收", () => {
    const base = { seq: 3, at: "2026-11-06T02:00:00.000Z", sessionId };
    expect(Value.Check(LocalSessionEvent, { ...base, type: "assistant_text", text: "好" })).toBe(true);
    const progress = { done: 1, total: 3, step: 2, current: "写测试" };
    expect(Value.Check(LocalSessionEvent, { ...base, type: "plan", entries: [{ content: "读代码", status: "completed" }, { content: "写测试", status: "in_progress" }, { content: "提交", status: "pending" }], progress })).toBe(true);
    // 计划事件一定带「第几步 / 共几步」
    expect(Value.Check(LocalSessionEvent, { ...base, type: "plan", entries: [{ content: "写测试", status: "in_progress" }] })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { ...base, type: "assistant_text", text: "好", raw: {} })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { ...base, seq: 0, type: "assistant_text", text: "好" })).toBe(false);
  });

  it("同步载荷带幂等键；产出物有大小上限；不收未知类型", () => {
    const slots = { max: 3, running: 2, queued: 1 };
    const item = { key: `${deviceId}:${sessionId}:7`, sessionId, subject: { kind: "card", cardId: "task-1" }, occurredAt: "2026-11-06T02:00:00.000Z" };
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [
      { ...item, type: "status", data: { status: "running", title: "修登录页", agent: "claude-code", modelLabel: "订阅" } },
      { ...item, type: "cost", data: { modelLabel: "订阅", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } } },
    ] })).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [] })).toBe(false);
    // 每一批都带本机的位置数
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", items: [{ ...item, type: "status", data: { status: "queued", title: "x", agent: "claude-code", modelLabel: "订阅" } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...item, type: "status", data: { status: "queued", title: "x", agent: "claude-code", modelLabel: "订阅" } }] })).toBe(true);
    // 交回点名产出和证据；专题新的一版、存进飞书的地址
    const topic = { ...item, subject: { kind: "topic", topicId: "t-1" } };
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [
      { ...item, type: "handback", data: { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "a.md" }], outputKeys: [`${deviceId}:${sessionId}:3`] } },
      { ...topic, type: "topic_version", data: { number: 3, kind: "review", label: null, note: "合成了三方意见", body: "# 分歧和建议" } },
      { ...topic, type: "topic_version_feishu", data: { number: 3, feishuUrl: "https://x.feishu.cn/docx/abc" } },
    ] })).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...item, type: "handback", data: { summary: "x", criteria: [] } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...topic, type: "topic_version", data: { number: 1, kind: "final", label: null, note: null, body: "x" } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...topic, type: "topic_version_feishu", data: { number: 1, feishuUrl: "http://x" } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...item, type: "repo_files", data: {} }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...item, type: "artifact", data: {
      artifactId: "a1", title: "方案", fileName: "a.md", mimeType: "text/markdown", size: 11 * 1024 * 1024, sha256: "0".repeat(64), contentBase64: "",
    } }] })).toBe(false);
  });

  it("一批开工、同时跑的上限和排队位置", () => {
    const one = { subject: { kind: "card", cardId: "task-1" }, title: "修登录页", firstMessage: "开始" };
    expect(Value.Check(LocalCreateSessionBatchRequest, { items: [one, { ...one, subject: { kind: "card", cardId: "task-2" } }] })).toBe(true);
    expect(Value.Check(LocalCreateSessionBatchRequest, { items: [] })).toBe(false);
    expect(Value.Check(LocalCreateSessionBatchRequest, { items: Array.from({ length: 21 }, () => one) })).toBe(false);
    expect(Value.Check(LocalCreateSessionBatchResponse, { results: [{ ok: false, error: { code: "folder_not_allowed", message: "x" } }] })).toBe(true);
    expect(Value.Check(LocalSettingsPatch, { maxConcurrent: 5 })).toBe(true);
    expect(Value.Check(LocalSettingsPatch, { maxConcurrent: 0 })).toBe(false);
    expect(Value.Check(LocalSettingsPatch, { maxConcurrent: 11 })).toBe(false);
    expect(LocalSessionSummary.properties).toHaveProperty("queuePosition");
    expect(LocalHealthResponse.properties).toHaveProperty("slots");
    expect(LOCAL_RUNNER_ROUTES.createSessionBatch).toEqual({ method: "POST", path: "/v1/sessions/batch", auth: true });
  });

  it("规划员和验收员：会话种类、派活单草稿、验收结论、验收交代（V2 设计第 21 节）", () => {
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "plan", taskId: "task-9" }, title: "拆卡：登录改版", firstMessage: "拆卡交代" })).toBe(true);
    const slots = { max: 3, running: 1, queued: 0 };
    const at = "2026-11-06T02:00:00.000Z";
    const handbackKey = `${deviceId}:${sessionId}:4`;
    const plan = { key: `${deviceId}:${sessionId}:2`, sessionId, subject: { kind: "plan", taskId: "task-9" }, occurredAt: at };
    const verify = { key: `${deviceId}:${sessionId}:3`, sessionId, subject: { kind: "verify", cardId: "card-1", handbackKey }, occurredAt: at };
    const card = { title: "改登录页", brief: "按约定第 1 条改", doneDefinition: "页面能登录\n有截图", criterionIndex: 1, role: "前端", modelTier: "normal", why: null };
    const cardPlan = { revision: 1, summary: "两件", steps: [{ title: "先改页面", detail: null }], risks: [], cards: [card, { ...card, criterionIndex: null, role: null }], modelLabel: "haiku", roleId: null, roleVersion: null };
    const verdict = {
      passed: false, summary: "第 2 条没证据", beyondScope: ["顺手补个测试"], modelLabel: "haiku", roleId: sessionId, roleVersion: 3,
      criteria: [{ index: 1, verdict: "met", reason: "能登录", evidence: "截图 A1", fix: null }, { index: 2, verdict: "unmet", reason: "没截图", evidence: null, fix: "补截图" }],
    };
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...plan, type: "card_plan", data: cardPlan }, { ...verify, type: "verdict", data: verdict }] })).toBe(true);
    // 派活单至少一件、最多 8 件，档位只认三档；结论至少判一条
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...plan, type: "card_plan", data: { ...cardPlan, cards: [] } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...plan, type: "card_plan", data: { ...cardPlan, cards: Array.from({ length: 9 }, () => card) } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...plan, type: "card_plan", data: { ...cardPlan, cards: [{ ...card, modelTier: "max" }] } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...verify, type: "verdict", data: { ...verdict, criteria: [] } }] })).toBe(false);
    // 卡的会话和验收会话里的结论事件：没过、第几次、受阻没有、送回的改法
    const base = { seq: 9, at, sessionId };
    expect(Value.Check(LocalSessionEvent, { ...base, type: "verdict", handbackKey, passed: false, summary: "x", criteria: verdict.criteria, beyondScope: [], failStreak: 2, blocked: true, returnText: "验收没过：…" })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { ...base, type: "verdict", handbackKey, passed: true, summary: "x", criteria: verdict.criteria, beyondScope: [], failStreak: 0, blocked: false })).toBe(false);
    // 验收交代：第一句话、交回时的完成标准、验收员岗位（可空）、之前连续没过几次
    expect(LOCAL_RUNNER_VERIFY_BRIEF_PATH).toBe("/api/local-runner/verify-brief");
    const role = { id: sessionId, name: "验收员", kind: "reviewer", dutiesMd: "逐条判", practiceMd: "", acceptanceMd: "", tools: ["tianshu"], modelTier: "light", version: 1 };
    expect(Value.Check(LocalVerifyBriefResponse, { markdown: "# 验收", criteria: ["页面能登录", "有截图"], role, failStreak: 1 })).toBe(true);
    expect(Value.Check(LocalVerifyBriefResponse, { markdown: "# 验收", criteria: [], role: null, failStreak: 0 })).toBe(false);
  });

  it("配对口令只在批准后出现；路由表里只有健康和配对不要口令", () => {
    expect(Value.Check(LocalPairingStatusResponse, { status: "pending" })).toBe(true);
    const open = Object.values(LOCAL_RUNNER_ROUTES).filter((r) => !r.auth).map((r) => r.path);
    expect(open).toEqual(["/v1/health", "/v1/pairings", "/v1/pairings/:pairingId"]);
  });
});
