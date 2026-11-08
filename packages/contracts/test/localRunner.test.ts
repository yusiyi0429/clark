import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LocalCreateSessionRequest, LocalModelProfileUpsert, LocalModelProfile, LocalPermissionDecisionRequest, LocalSessionEvent,
  LocalSyncBatchRequest, LocalPairingStatusResponse, LocalSendMessageRequest, LOCAL_RUNNER_ROUTES,
  LocalCreateSessionBatchRequest, LocalCreateSessionBatchResponse, LocalSettingsPatch, LocalSessionSummary, LocalHealthResponse,
  LocalVerifyBriefResponse, LOCAL_RUNNER_VERIFY_BRIEF_PATH, LocalMergeResponse, LocalVerdict, LocalQuestionAnswerRequest, LocalPlanCard, LocalBackgroundItem,
  LocalSettings, LocalMergeSync, LocalStatusResponse, LocalQuotaSource, LocalQuotaSync,
  LocalFolder, LocalProjectFolder, LocalProjectListResponse, LocalProjectFolderRequest, LocalHandoverCheck, LocalProjectCloneRequest, LocalProjectCloneResponse, ProjectTransfer,
  LocalTaskBudgetView, LocalBudgetListResponse, LocalBudgetUpdateRequest, LocalSendMessageRequest as SendMessage, LocalPermissionBrief, LOCAL_RUNNER_ATTACHMENT_PATH,
  LocalRunPreviewRequest, LocalPermissionModeRequest, LOCAL_AGENT_PERMISSION_MODES, LocalTool, LocalToolUpsert,
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

  it("本人加的工具：只收 HTTP 地址、不收命令，钥匙只写不读", () => {
    expect(Value.Check(LocalToolUpsert, { name: "金蝶", preset: "kingdee", url: "https://kd.example.com/mcp", apiKey: "k-1" })).toBe(true);
    expect(Value.Check(LocalToolUpsert, { name: "看板", preset: "custom", url: "http://127.0.0.1:9000/mcp", keyHeader: "X-Api-Key" })).toBe(true);
    expect(Value.Check(LocalToolUpsert, { name: "x", preset: "custom", url: "https://a.example.com", command: "node", args: ["x.js"] })).toBe(false);
    expect(Value.Check(LocalToolUpsert, { name: "x", preset: "custom", url: "file:///C:/x.exe" })).toBe(false);
    expect(Value.Check(LocalToolUpsert, { name: "x", preset: "github", url: "https://a.example.com" })).toBe(false);
    expect(Value.Check(LocalToolUpsert, { name: "x", preset: "custom", url: "https://a.example.com", keyHeader: "Bad: header" })).toBe(false);
    expect(Value.Check(LocalToolUpsert, { name: "x", preset: "custom", url: "https://a.example.com", apiKey: "k\nadd-generic-password" })).toBe(false);
    expect(LocalTool.properties).not.toHaveProperty("apiKey");
    expect(LocalTool.properties).toHaveProperty("hasKey");
    expect(LOCAL_RUNNER_ROUTES.checkTool).toEqual({ method: "POST", path: "/v1/tools/:id/check", auth: true });
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
    // 子会话消息回执（17.4）：user_message 带编号，receipt 形状同伙伴对话的 { state, messageId }，多一个 failed
    const messageId = "5f0c2b8e-3d4a-4f6b-9c1d-2e3f4a5b6c7d";
    expect(Value.Check(LocalSessionEvent, { ...base, type: "user_message", text: "也截一张图", source: "web", messageId })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { ...base, type: "user_message", text: "老日志没有编号", source: "web" })).toBe(true);
    for (const state of ["delivered", "read", "failed"]) expect(Value.Check(LocalSessionEvent, { ...base, type: "receipt", messageId, state })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { ...base, type: "receipt", messageId, state: "sent" })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { ...base, type: "receipt", state: "read" })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { ...base, seq: 0, type: "assistant_text", text: "好" })).toBe(false);
  });

  it("同步载荷带幂等键；产出物有大小上限；不收未知类型", () => {
    const slots = { max: 3, running: 2, queued: 1 };
    const item = { key: `${deviceId}:${sessionId}:7`, sessionId, subject: { kind: "card", cardId: "task-1" }, occurredAt: "2026-11-06T02:00:00.000Z" };
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [
      { ...item, type: "status", data: { status: "running", title: "修登录页", agent: "claude-code", modelLabel: "订阅" } },
      { ...item, type: "cost", data: { modelLabel: "订阅", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } } },
    ] })).toBe(true);
    // 手机端看子会话的对话和回执：本人说的一句（只报文件名）、回执各一条
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [
      { ...item, type: "user_message", data: { messageId: "5f0c2b8e-3d4a-4f6b-9c1d-2e3f4a5b6c7d", text: "也截一张图", attachments: ["登录页.png"] } },
      { ...item, type: "receipt", data: { messageId: "5f0c2b8e-3d4a-4f6b-9c1d-2e3f4a5b6c7d", state: "read" } },
    ] })).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [
      { ...item, type: "receipt", data: { messageId: "5f0c2b8e-3d4a-4f6b-9c1d-2e3f4a5b6c7d", state: "queued" } },
    ] })).toBe(false);
    // 空的一批是心跳
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [] })).toBe(true);
    // 每一批都带本机的位置数
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", items: [{ ...item, type: "status", data: { status: "queued", title: "x", agent: "claude-code", modelLabel: "订阅" } }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...item, type: "status", data: { status: "queued", title: "x", agent: "claude-code", modelLabel: "订阅", queuePosition: 2 } }] })).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots, items: [{ ...item, type: "status", data: { status: "queued", title: "x", agent: "claude-code", modelLabel: "订阅", queuePosition: 0 } }] })).toBe(false);
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
    expect(Value.Check(LocalSettingsPatch, { maxConcurrent: 11 })).toBe(true); // 不设上限，超过 10 个网页提醒
    expect(Value.Check(LocalSettingsPatch, { maxConcurrent: 1.5 })).toBe(false);
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

  it("卡的工作树：会话摘要说在哪做，交回和结论带提交，同步带分支，合回的结果（ADR 0038）", () => {
    const sha = "a".repeat(40);
    const at = "2026-11-06T02:00:00.000Z";
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const summary = {
      id: sessionId, subject: { kind: "card", cardId: "card-1" }, title: "改登录页", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
      cwd: "C:/data/worktrees/card-1", status: "running", includePersonalConfig: false, createdAt: at, updatedAt: at, lastSeq: 3, pendingPermissions: 0, permissionMode: "auto", queuePosition: null, usage,
    };
    const worktree = { kind: "worktree", folder: "D:/repo", path: "C:/data/worktrees/card-1", branch: "tianshu/card1-login", baseBranch: "main", baseCommit: sha, mergedCommit: null };
    expect(Value.Check(LocalSessionSummary, { ...summary, workspace: worktree })).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...summary, workspace: { kind: "folder", folder: "D:/notes" } })).toBe(true);
    expect(Value.Check(LocalSessionSummary, summary)).toBe(true); // 专题、规划员、验收员不带
    expect(Value.Check(LocalSessionSummary, { ...summary, workspace: { ...worktree, baseCommit: "abc1234" } })).toBe(false); // 提交号要完整
    expect(Value.Check(LocalSessionSummary, { ...summary, workspace: { kind: "folder", folder: "D:/notes", branch: "x" } })).toBe(false);

    const item = { key: `${deviceId}:${sessionId}:5`, sessionId, subject: { kind: "card", cardId: "card-1" }, occurredAt: at };
    const git = { branch: "tianshu/card1-login", baseBranch: "main", baseCommit: sha, commit: "b".repeat(40) };
    const handback = { summary: "做完了", criteria: [], outputKeys: [] };
    const batch = (data: unknown) => ({ deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 }, items: [{ ...item, type: "handback", data }] });
    expect(Value.Check(LocalSyncBatchRequest, batch({ ...handback, git }))).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, batch(handback))).toBe(true); // 在文件夹里做的卡不带
    expect(Value.Check(LocalSyncBatchRequest, batch({ ...handback, git: { ...git, commit: undefined } }))).toBe(false);
    expect(Value.Check(LocalSessionEvent, { seq: 1, at, sessionId, type: "handback", ...handback, commit: git.commit })).toBe(true);
    const verdict = { passed: true, summary: "都达到了", criteria: [{ index: 1, verdict: "met", reason: "能登录", evidence: null, fix: null }], beyondScope: [], modelLabel: "haiku", roleId: null, roleVersion: null };
    expect(Value.Check(LocalVerdict, { ...verdict, commit: git.commit })).toBe(true);
    expect(Value.Check(LocalVerdict, verdict)).toBe(true);
    // 本人原话对不上（16.8）：写明是哪句、漏了还是多做了；没有时不带，带了不能是空数组
    expect(Value.Check(LocalVerdict, { ...verdict, passed: false, sourceWordIssues: [{ quote: "登录页要有忘记密码", kind: "missing", reason: "没有忘记密码" }] })).toBe(true);
    expect(Value.Check(LocalVerdict, { ...verdict, sourceWordIssues: [{ quote: "x", kind: "wrong", reason: "x" }] })).toBe(false);
    expect(Value.Check(LocalVerdict, { ...verdict, sourceWordIssues: [] })).toBe(false);
    // 云端带上原话（16.8）：验收交代、派活单都收得下（本机严格校验，多一个字段就会拒）
    expect(Value.Check(LocalVerifyBriefResponse, { markdown: "## 本人原话", criteria: ["能登录"], role: null, failStreak: 0, sourceWords: ["登录页要有忘记密码"] })).toBe(true);
    expect(Value.Check(LocalPlanCard, { title: "改登录页", brief: "", doneDefinition: "能登录", criterionIndex: null, role: null, modelTier: "normal", why: null, sourceWords: ["登录页要有忘记密码"] })).toBe(true);

    expect(LOCAL_RUNNER_ROUTES.mergeSession).toEqual({ method: "POST", path: "/v1/sessions/:id/merge", auth: true });
    expect(Value.Check(LocalMergeResponse, { merged: true, commit: sha, session: { ...summary, workspace: { ...worktree, mergedCommit: sha } } })).toBe(true);
    for (const reason of ["base_not_checked_out", "dirty", "conflict"]) {
      expect(Value.Check(LocalMergeResponse, { merged: false, reason, message: "合不了", files: ["src/a.ts"] })).toBe(true);
    }
    expect(Value.Check(LocalMergeResponse, { merged: false, reason: "card_running", message: "x", files: [] })).toBe(false);
  });

  it("提问：摘要带在等的提问（等你回复），事件有提问和了结，网页按问题给选中的选项和一句话", () => {
    const at = "2026-11-07T02:00:00.000Z";
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const summary = {
      id: sessionId, subject: { kind: "card", cardId: "card-3" }, title: "总验收", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
      cwd: "C:/data/worktrees/card-3", status: "idle", includePersonalConfig: false, createdAt: at, updatedAt: at, lastSeq: 9, pendingPermissions: 0, permissionMode: "auto", queuePosition: null, usage,
    };
    const request = {
      requestId: "toolu_ask1", askedAt: at,
      questions: [
        { question: "等前两张交回，还是先预跑？", header: "先后", multiSelect: false, options: [{ label: "等交回", description: "前两张合回后再跑" }, { label: "先预跑", description: "" }] },
        { question: "要跑哪些检查？", header: "检查", multiSelect: true, options: [{ label: "单测", description: "npm test" }, { label: "类型检查", description: "tsc" }] },
      ],
    };
    expect(Value.Check(LocalSessionSummary, { ...summary, pendingQuestion: request })).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...summary, pendingQuestion: { ...request, questions: [] } })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { seq: 9, at, sessionId, type: "question", request })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 10, at, sessionId, type: "question_resolved", requestId: "toolu_ask1", choices: [["等交回"], ["单测", "类型检查"]], text: null })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 10, at, sessionId, type: "question_resolved", requestId: "toolu_ask1", choices: null, text: null })).toBe(true); // 作废
    expect(LOCAL_RUNNER_ROUTES.answerQuestion).toEqual({ method: "POST", path: "/v1/sessions/:id/questions/:requestId", auth: true });
    expect(Value.Check(LocalQuestionAnswerRequest, { choices: [["等交回"], ["单测"]] })).toBe(true);
    expect(Value.Check(LocalQuestionAnswerRequest, { choices: [[], []], text: "先跑单测，别的不用" })).toBe(true);
    expect(Value.Check(LocalQuestionAnswerRequest, { choices: [] })).toBe(false);
    expect(Value.Check(LocalQuestionAnswerRequest, { choices: [["等交回"]], text: "" })).toBe(false);
  });

  it("卡的先后：派活单写等哪几件，开工请求带要等的卡，排着时摘要和同步带还在等的卡", () => {
    const card = { title: "总验收", brief: "前两张合回后跑测试", doneDefinition: "npm test 全过", criterionIndex: 3, role: null, modelTier: "light", why: null };
    expect(Value.Check(LocalPlanCard, { ...card, after: [1, 2] })).toBe(true);
    expect(Value.Check(LocalPlanCard, card)).toBe(true); // 不填就是不用等
    expect(Value.Check(LocalPlanCard, { ...card, after: [0] })).toBe(false);
    const start = { subject: { kind: "card", cardId: "card-3" }, title: "总验收", cwd: "D:/repo", firstMessage: "做总验收" };
    expect(Value.Check(LocalCreateSessionRequest, { ...start, after: ["card-1", "card-2"] })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { ...start, after: [""] })).toBe(false);
    const at = "2026-11-07T02:00:00.000Z";
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const queued = {
      id: sessionId, subject: start.subject, title: "总验收", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
      cwd: "D:/repo", status: "queued", includePersonalConfig: false, createdAt: at, updatedAt: at, lastSeq: 1, pendingPermissions: 0, permissionMode: "auto", queuePosition: 1, usage,
    };
    expect(Value.Check(LocalSessionSummary, { ...queued, waitingFor: ["card-2"] })).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...queued, waitingFor: [] })).toBe(false); // 不在等就不带
    const item = { key: `${deviceId}:${sessionId}:2`, sessionId, subject: start.subject, occurredAt: at, type: "status" };
    const batch = (data: unknown) => ({ deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 2, queued: 1 }, items: [{ ...item, data }] });
    const status = { status: "queued", title: "总验收", agent: "claude-code", modelLabel: "订阅", queuePosition: 1 };
    expect(Value.Check(LocalSyncBatchRequest, batch({ ...status, waitingFor: ["card-1", "card-2"] }))).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, batch(status))).toBe(true);
  });

  it("后台任务：会话摘要列出子 agent 和后台命令，事件和同步条目每次带全部字段，可以停", () => {
    const at = "2026-11-07T02:00:00.000Z";
    const agent = { id: "a87b163c2898fa14a", title: "数文件", kind: "subagent", state: "running", startedAt: at, finishedAt: null, stoppable: true };
    const cmd = { id: "bbvrkzzoy", title: "后台等待 30 秒", kind: "command", state: "stopped", startedAt: at, finishedAt: at, stoppable: false };
    expect(Value.Check(LocalBackgroundItem, agent)).toBe(true);
    expect(Value.Check(LocalBackgroundItem, cmd)).toBe(true);
    expect(Value.Check(LocalBackgroundItem, { ...agent, kind: "plan" })).toBe(false); // 规划员、验收员、合回是云端自己知道的，不在这里
    expect(Value.Check(LocalBackgroundItem, { ...agent, state: "killed" })).toBe(false);
    expect(Value.Check(LocalBackgroundItem, { ...agent, finishedAt: undefined })).toBe(false);
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const summary = {
      id: sessionId, subject: { kind: "card", cardId: "card-1" }, title: "改登录页", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
      cwd: "D:/repo", status: "running", includePersonalConfig: false, createdAt: at, updatedAt: at, lastSeq: 9, pendingPermissions: 0, permissionMode: "auto", queuePosition: null, usage,
    };
    expect(Value.Check(LocalSessionSummary, { ...summary, background: [agent, cmd] })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 10, at, sessionId, type: "background", item: cmd })).toBe(true);
    const batch = { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 }, items: [{ key: `${deviceId}:${sessionId}:11`, sessionId, subject: summary.subject, occurredAt: at, type: "background", data: agent }] };
    expect(Value.Check(LocalSyncBatchRequest, batch)).toBe(true);
    expect(LOCAL_RUNNER_ROUTES.stopBackground).toEqual({ method: "POST", path: "/v1/sessions/:id/background/:itemId/stop", auth: true });
  });

  it("交完收工是 done；验收过就合回是设置；没合回的卡带 needsMerge；合回结果按交回同步", () => {
    const at = "2026-11-07T04:30:00.000Z";
    const sha = "a".repeat(40);
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    const plan = {
      id: sessionId, subject: { kind: "plan", taskId: "task-1" }, title: "拆卡", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
      cwd: "D:/plans/task-1", status: "done", includePersonalConfig: false, createdAt: at, updatedAt: at, lastSeq: 9, pendingPermissions: 0, permissionMode: "auto", queuePosition: null, usage,
    };
    expect(Value.Check(LocalSessionSummary, plan)).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 10, at, sessionId, type: "status", status: "done", reason: "计划交了" })).toBe(true);

    const settings = { includePersonalConfigByDefault: false, allowedOrigins: [], paused: false, maxConcurrent: 3, autoMerge: true };
    expect(Value.Check(LocalSettings, settings)).toBe(true);
    expect(Value.Check(LocalSettings, { ...settings, autoMerge: undefined })).toBe(false);
    expect(Value.Check(LocalSettingsPatch, { autoMerge: false })).toBe(true);

    const workspace = { kind: "worktree", folder: "D:/repo", path: "D:/data/worktrees/c1", branch: "tianshu/c1-login", baseBranch: "main", baseCommit: sha, mergedCommit: null };
    const card = { ...plan, subject: { kind: "card", cardId: "card-1" }, status: "idle", workspace };
    expect(Value.Check(LocalSessionSummary, card)).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...card, workspace: { ...workspace, needsMerge: { reason: "dirty", message: "主文件夹有没提交的改动：readme.md" } } })).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...card, workspace: { ...workspace, needsMerge: { reason: "busy", message: "x" } } })).toBe(false);

    const key = `${deviceId}:${sessionId}:12`;
    const merged = { handbackKey: key, merged: true, commit: sha, baseBranch: "main", reason: null, message: null, auto: true };
    const held = { handbackKey: key, merged: false, commit: null, baseBranch: "main", reason: "auto_merge_off", message: "没开「验收过就合回」，等你合", auto: true };
    for (const m of [merged, held, { ...held, reason: "not_ready", message: "交回以后卡又改过" }, { ...merged, auto: false }]) expect(Value.Check(LocalMergeSync, m)).toBe(true);
    expect(Value.Check(LocalMergeSync, { ...held, reason: "busy" })).toBe(false);
    const batch = { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, items: [{ key: `${deviceId}:${sessionId}:13`, sessionId, subject: card.subject, occurredAt: at, type: "merge", data: merged }] };
    expect(Value.Check(LocalSyncBatchRequest, batch)).toBe(true);
  });

  it("额度和命令行工具在本机状态里；额度用完的卡停着等（hold、usage_limit）；花费分订阅和网关、网关带真钱；开工带档位；同步只带百分比、状态、时间", () => {
    const at = "2026-11-07T07:00:00.000Z";
    const claude = {
      id: "claude", name: "Claude", kind: "subscription", remainingPercent: 21, amounts: [], resetsAt: "2026-11-07T00:00:00.229Z",
      plan: "max", blockedUntil: null, extraUsage: false, updatedAt: at, error: null,
      windows: [
        { kind: "weekly_all", model: null, usedPercent: 79, state: "warning", resetsAt: "2026-11-07T00:00:00.229Z" },
        { kind: "weekly_scoped", model: "Fable", usedPercent: 4, state: "ok", resetsAt: "2026-11-07T00:00:00.229Z" },
      ],
    };
    expect(Value.Check(LocalQuotaSource, claude)).toBe(true);
    expect(Value.Check(LocalQuotaSource, { ...claude, windows: [{ ...claude.windows[0], usedPercent: 101 }] })).toBe(false);
    expect(Value.Check(LocalQuotaSource, { ...claude, email: "x@example.com" })).toBe(false); // 账号信息放不进来
    const codex = { id: "codex", name: "Codex", kind: "subscription", remainingPercent: 79, amounts: [], resetsAt: at, plan: "plus", blockedUntil: null, extraUsage: null, updatedAt: at, error: null, windows: [{ kind: "session", model: null, usedPercent: 0, state: "ok", resetsAt: at }, { kind: "weekly_all", model: null, usedPercent: 21, state: "ok", resetsAt: at }] };
    expect(Value.Check(LocalQuotaSource, codex)).toBe(true);
    expect(Value.Check(LocalQuotaSource, { ...codex, kind: "plan" })).toBe(false);
    // TokenHub 当天花费、别的 API 余额（形状先留着）
    const tokenhub = { id: "tokenhub:tokenhub.corp.tokenkingos.com", name: "TokenHub", kind: "daily_spend", remainingPercent: null, amounts: [{ amount: 12.4, currency: "CNY", estimated: false }],
      monthAmounts: [{ amount: 230, currency: "CNY", estimated: false }], windows: [], resetsAt: null, blockedUntil: null, plan: null, extraUsage: null, updatedAt: at, error: null };
    const minimax = { ...tokenhub, id: "api:minimax", name: "MiniMax", kind: "api_balance", amounts: [{ amount: 88, currency: "CNY", estimated: false }], monthAmounts: undefined };
    delete (minimax as { monthAmounts?: unknown }).monthAmounts;
    for (const q of [tokenhub, minimax]) expect(Value.Check(LocalQuotaSource, q)).toBe(true);
    expect(Value.Check(LocalQuotaSource, { ...tokenhub, account: "sunm" })).toBe(false); // 账户名放不进来
    const tools = [
      { kind: "gh", state: "ready", version: "2.88.0", account: "someone", checkedAt: at },
      { kind: "lark-cli", state: "expired", version: "1.0.93", account: "孙铭泽", checkedAt: at },
    ];
    const settings = { includePersonalConfigByDefault: false, allowedOrigins: [], paused: false, maxConcurrent: 3, autoMerge: true };
    const status = {
      deviceId, version: "0.1.0", agents: [], activeSessions: 0, slots: { max: 3, running: 0, queued: 0 },
      cloud: { linked: false, apiBaseUrl: null, personName: null, personId: null, outbox: { pending: 0, lastSyncedAt: null, lastError: null } }, settings, quota: [claude, codex, tokenhub, minimax], tools: [{ kind: "claude-code", state: "ready", version: "2.1.318", account: null, checkedAt: at }, { kind: "codex", state: "not_logged_in", version: "0.159.2", account: null, checkedAt: at }, ...tools],
    };
    expect(Value.Check(LocalStatusResponse, status)).toBe(true);
    expect(Value.Check(LocalStatusResponse, { ...status, tools: [{ ...tools[0], kind: "git" }] })).toBe(false);

    // 额度用完：一轮以 usage_limit 结束，卡停着等（摘要、状态事件、状态条目都带 hold）
    const hold = { reason: "usage_limit", until: "2026-11-07T00:00:00.000Z" };
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
    expect(Value.Check(LocalSessionEvent, { seq: 3, at, sessionId, type: "turn_end", isError: true, text: null, durationMs: 1, usage, errorKind: "usage_limit" })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 4, at, sessionId, type: "status", status: "idle", hold })).toBe(true);
    const summary = {
      id: sessionId, subject: { kind: "card", cardId: "card-1" }, title: "改登录页", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
      cwd: "D:/repo", status: "idle", includePersonalConfig: false, createdAt: at, updatedAt: at, lastSeq: 4, pendingPermissions: 0, permissionMode: "auto", queuePosition: null, usage, hold,
    };
    expect(Value.Check(LocalSessionSummary, summary)).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...summary, hold: { reason: "paused", until: null } })).toBe(false);
    const key = (n: number) => `${deviceId}:${sessionId}:${n}`;
    const base = { sessionId, subject: summary.subject, occurredAt: at };
    const sync = { quota: [{ id: "claude", name: "Claude", kind: "subscription", remainingPercent: 21, amounts: [], windows: claude.windows, resetsAt: claude.resetsAt, blockedUntil: null, updatedAt: at },
      { id: tokenhub.id, name: "TokenHub", kind: "daily_spend", remainingPercent: null, amounts: tokenhub.amounts, monthAmounts: tokenhub.monthAmounts, windows: [], resetsAt: null, blockedUntil: null, updatedAt: at }] };
    expect(Value.Check(LocalQuotaSync, sync.quota[0])).toBe(true);
    expect(Value.Check(LocalQuotaSync, { ...sync.quota[0], plan: "max" })).toBe(false); // 计划名不同步
    const items = [
      { ...base, key: key(5), type: "status", data: { status: "idle", title: "改登录页", agent: "claude-code", modelLabel: "订阅", hold } },
      { ...base, key: key(6), type: "cost", data: { modelLabel: "订阅", usage: { ...usage, costUsd: 0.12 }, source: "subscription", model: "claude-opus-5-5", money: null } },
      { ...base, key: key(7), type: "cost", data: { modelLabel: "DeepSeek", usage, source: "gateway", model: "wangsu/deepseek-v4.1-flash", money: { amount: 0.031, currency: "CNY", estimated: true } } },
      { ...base, key: key(8), type: "cost", data: { modelLabel: "旧版本机", usage } }, // 旧版本机发的不带来源也收
    ];
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, ...sync, items })).toBe(true);

    // 开工带档位（订阅模型按档位选模型和思考强度）
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "card", cardId: "c1" }, title: "x", firstMessage: "做", modelTier: "light" })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { subject: { kind: "card", cardId: "c1" }, title: "x", firstMessage: "做", modelTier: "max" })).toBe(false);
  });

  it("预算：开工带 Task 和预算；本机记账回 GET /v1/budgets，PUT /v1/budgets 改；用完的卡停着等（hold budget），余额不足停着等本人（balance）；卡带跑法；TokenHub 花费进状态和同步", () => {
    const at = "2026-11-07T07:00:00.000Z";
    const set = { mode: "set", hours: 2, weeklyPercent: 10, money: { amount: 50, currency: "CNY" } };
    const auto = { mode: "auto", hours: null, weeklyPercent: null, money: null };
    const req = { subject: { kind: "card", cardId: "c1" }, title: "x", firstMessage: "做" };
    expect(Value.Check(LocalCreateSessionRequest, { ...req, taskBudget: { taskId: "T-1", budget: set } })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { ...req, taskBudget: { taskId: null, budget: auto } })).toBe(true); // 不挂 Task 的专题
    expect(Value.Check(LocalCreateSessionRequest, { ...req, taskBudget: { taskId: "T-1", budget: { ...set, mode: "max" } } })).toBe(false);
    const view = {
      taskId: "T-1", sessionId: null, budget: set, spent: { hours: 1.6, weeklyPercent: 3, money: { amount: 12.5, currency: "CNY", estimated: true } },
      ratio: 0.8, state: "warning", since: at, updatedAt: at,
    };
    expect(Value.Check(LocalTaskBudgetView, view)).toBe(true);
    expect(Value.Check(LocalTaskBudgetView, { ...view, budget: auto, ratio: null, state: "ok", spent: { hours: 0, weeklyPercent: null, money: null } })).toBe(true);
    expect(Value.Check(LocalTaskBudgetView, { ...view, state: "over" })).toBe(false);
    expect(Value.Check(LocalBudgetListResponse, { budgets: [view] })).toBe(true);
    expect(Value.Check(LocalBudgetUpdateRequest, { taskId: "T-1", budget: { ...set, hours: 3 } })).toBe(true);
    expect(Value.Check(LocalBudgetUpdateRequest, { sessionId, budget: set })).toBe(true);
    expect(LOCAL_RUNNER_ROUTES.putBudget).toEqual({ method: "PUT", path: "/v1/budgets", auth: true });

    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null };
    const run = { mode: "unlimited", model: "opus", effort: "max", multiAgent: true };
    const summary = {
      id: sessionId, subject: { kind: "card", cardId: "card-1" }, title: "改登录页", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
      cwd: "D:/repo", status: "idle", includePersonalConfig: false, createdAt: at, updatedAt: at, lastSeq: 4, pendingPermissions: 0, permissionMode: "auto", queuePosition: null, usage,
      hold: { reason: "budget", until: null }, run,
    };
    expect(Value.Check(LocalSessionSummary, summary)).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...summary, hold: { reason: "balance", until: null }, run: { ...run, mode: "set", effort: null, multiAgent: false } })).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...summary, run: { ...run, effort: "ultra" } })).toBe(false);
    // 哪个来源的哪个模型：开工前定的，和执行方实际报的（以实际为准）；老版本本机报的没有这几项也收
    const named = { ...run, source: "subscription", sourceLabel: "我的 Claude 订阅", modelName: "Opus 5.5", actual: { model: "claude-opus-5-5", modelName: "Opus 5.5", at } };
    expect(Value.Check(LocalSessionSummary, { ...summary, run: named })).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...summary, run: { ...named, source: "gateway", sourceLabel: "TokenHub", model: "wangsu/qwen3.8-flash", modelName: "qwen3.8-flash", actual: null } })).toBe(true);
    expect(Value.Check(LocalSessionSummary, { ...summary, run: { ...named, source: "tokenhub" } })).toBe(false);
    expect(Value.Check(LocalSessionSummary, { ...summary, run: { ...named, actual: { model: "", modelName: "x", at } } })).toBe(false);
    expect(Value.Check(LocalRunPreviewRequest, { modelProfileId: "subscription", modelTier: "light", taskBudget: { taskId: "T-1", budget: set } })).toBe(true);
    expect(Value.Check(LocalRunPreviewRequest, {})).toBe(true);
    expect(Value.Check(LocalRunPreviewRequest, { title: "多余" })).toBe(false);
    expect(LOCAL_RUNNER_ROUTES.previewRun).toEqual({ method: "POST", path: "/v1/runs/preview", auth: true });

    // 权限模式：开工带、摘要里有（必填）、中途换、事件和同步条目带；五档以外的不收；Codex 没有「先出计划」
    expect(Value.Check(LocalCreateSessionRequest, { ...req, permissionMode: "acceptEdits" })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { ...req, permissionMode: "dontAsk" })).toBe(false);
    expect(Value.Check(LocalSessionSummary, { ...summary, permissionMode: "plan" })).toBe(true);
    const { permissionMode: _pm, ...noMode } = summary as Record<string, unknown>;
    expect(Value.Check(LocalSessionSummary, noMode)).toBe(false);
    expect(Value.Check(LocalPermissionModeRequest, { mode: "bypassPermissions" })).toBe(true);
    expect(Value.Check(LocalPermissionModeRequest, { mode: "manual" })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { seq: 5, at, sessionId, type: "permission_mode", mode: "auto", by: "plan_approved" })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { seq: 5, at, sessionId, type: "permission_mode", mode: "auto", by: "cloud" })).toBe(false);
    expect(LOCAL_RUNNER_ROUTES.setPermissionMode).toEqual({ method: "PUT", path: "/v1/sessions/:id/permission-mode", auth: true });
    expect(LOCAL_AGENT_PERMISSION_MODES["claude-code"]).toEqual(["auto", "default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(LOCAL_AGENT_PERMISSION_MODES.codex).not.toContain("plan");
    expect(Value.Check(LocalSessionEvent, { seq: 3, at, sessionId, type: "turn_end", isError: true, text: null, durationMs: 1, usage, errorKind: "balance" })).toBe(true);

    const base = { sessionId, subject: summary.subject, occurredAt: at };
    const items = [
      { ...base, key: `${deviceId}:${sessionId}:9`, type: "budget", data: view },
      { ...base, key: `${deviceId}:${sessionId}:10`, type: "status", data: { status: "idle", title: "改登录页", agent: "claude-code", modelLabel: "订阅", hold: summary.hold, run } },
    ];
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, items })).toBe(true);

    // 状态条目带在问的提问、在等批准的那一步（B 的 aa6aba9e）
    const question = { requestId: "ask-1", questions: [{ question: "用哪个方案？", header: "方案", options: [{ label: "A", description: "" }], multiSelect: false }], askedAt: at };
    const permission = { requestId: "perm-1", toolName: "Bash", title: "运行 pnpm test", outsidePaths: [] };
    expect(Value.Check(LocalPermissionBrief, permission)).toBe(true);
    expect(Value.Check(LocalPermissionBrief, { ...permission, input: { command: "pnpm test" } })).toBe(false); // 完整输入不传
    const statusItems = [
      { ...base, key: `${deviceId}:${sessionId}:11`, type: "status", data: { status: "idle", title: "改登录页", agent: "claude-code", modelLabel: "订阅", question } },
      { ...base, key: `${deviceId}:${sessionId}:12`, type: "status", data: { status: "waiting_permission", title: "改登录页", agent: "claude-code", modelLabel: "订阅", permission } },
    ];
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, items: statusItems })).toBe(true);
    // 批准卡能不能给「这张卡都允许」（18.10）；老版本本机不带也收
    expect(Value.Check(LocalPermissionBrief, { ...permission, canAllowForSession: true })).toBe(true);

    // 停了的报告（18.10）：怎么停的、一两句摘要、卡在哪、这一轮的产出物
    const stopped = (data: unknown) => Value.Check(LocalSyncBatchRequest, {
      deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, items: [{ ...base, key: `${deviceId}:${sessionId}:13`, type: "stopped", data }],
    });
    const report = { why: "turn_done", summary: "登录页改好了，测试都过了。", blocker: null, outputs: [{ key: `${deviceId}:${sessionId}:7`, title: "改动说明", fileName: "说明.md" }], handbackKey: `${deviceId}:${sessionId}:8` };
    expect(stopped(report)).toBe(true);
    expect(stopped({ why: "held", summary: null, blocker: "订阅额度用完了，19:00 恢复后接着做", outputs: [] })).toBe(true);
    expect(stopped({ ...report, why: "paused" })).toBe(false);
    expect(stopped({ ...report, summary: "" })).toBe(false); // 没话说是 null，不是空串
    expect(stopped({ ...report, outputs: [{ key: "x", title: "t", fileName: "f" }] })).toBe(false);

    // 一句话带附件（14.5）：只说附件不说话也行；user_message 事件带存好的附件
    const ref = { id: "5b0c2f3e-6a1d-4c8e-9f2a-1b3c4d5e6f70", fileName: "截图.png", size: 1024, sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    expect(Value.Check(SendMessage, { attachments: [ref] })).toBe(true);
    expect(Value.Check(SendMessage, { attachments: [{ ...ref, sha256: "XYZ" }] })).toBe(false);
    expect(Value.Check(SendMessage, { text: "看看", attachments: [] })).toBe(false);
    expect(Value.Check(SendMessage, { attachments: Array.from({ length: 21 }, () => ref) })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { seq: 5, at, sessionId, type: "user_message", text: "", source: "web", attachments: [{ name: "截图.png", path: "D:/w/.tianshu-attachments/1/截图.png", size: 1024 }] })).toBe(true);
    expect(LOCAL_RUNNER_ATTACHMENT_PATH).toBe("/api/local-runner/attachments/:id");
  });

  it("项目（16.6）：文件夹挂在哪些项目上；项目绑哪个文件夹；开工和同步的 subject 带 projectId", () => {
    const at = "2026-11-07T07:00:00.000Z";
    const folder = { id: "f1a2b3c4d5e6", path: "D:/repo", label: "repo", addedAt: at };
    expect(Value.Check(LocalFolder, folder)).toBe(true); // 选文件夹的回执不带 projects
    expect(Value.Check(LocalFolder, { ...folder, projects: [{ projectId: "11111111-1111-4111-8111-111111111111", name: "天枢本机程序" }, { projectId: "22222222-2222-4222-8222-222222222222", name: null }] })).toBe(true);
    const bound = { projectId: "11111111-1111-4111-8111-111111111111", name: "天枢本机程序", folder: { id: folder.id, path: folder.path, label: folder.label }, updatedAt: at };
    expect(Value.Check(LocalProjectFolder, bound)).toBe(true);
    expect(Value.Check(LocalProjectFolder, { ...bound, folder: null })).toBe(true);
    expect(Value.Check(LocalProjectListResponse, { projects: [bound] })).toBe(true);
    expect(Value.Check(LocalProjectFolderRequest, { folderId: folder.id, name: "天枢本机程序" })).toBe(true);
    expect(Value.Check(LocalProjectFolderRequest, { folderId: null })).toBe(true);
    expect(Value.Check(LocalProjectFolderRequest, { path: "D:/repo" })).toBe(false); // 网页不能直接写路径
    expect(LOCAL_RUNNER_ROUTES.putProjectFolder).toEqual({ method: "PUT", path: "/v1/projects/:projectId/folder", auth: true });
    const subject = { kind: "card", cardId: "c1", projectId: "11111111-1111-4111-8111-111111111111" };
    expect(Value.Check(LocalCreateSessionRequest, { subject, title: "x", firstMessage: "做" })).toBe(true);
    const item = { key: `${deviceId}:${sessionId}:1`, sessionId, subject, occurredAt: at, type: "status", data: { status: "running", title: "x", agent: "claude-code", modelLabel: "订阅" } };
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", slots: { max: 3, running: 0, queued: 0 }, items: [item] })).toBe(true);

    // 项目转交（16.7）：交接检查只有 git 状态；接手后 clone
    const check = {
      projectId: "11111111-1111-4111-8111-111111111111", checkedAt: at, folder: { path: "D:/repo", label: "repo" },
      git: { branch: "main", remotes: [{ name: "origin", url: "https://github.com/TokenkingOS/Chat_Service.git" }], uncommitted: ["src/a.ts"], uncommittedCount: 1,
        unpushed: [{ branch: "main", upstream: "origin/main", ahead: 2 }, { branch: "tianshu/abc", upstream: null, ahead: null }] },
      recentFiles: null,
    };
    expect(Value.Check(LocalHandoverCheck, check)).toBe(true);
    expect(Value.Check(LocalHandoverCheck, { ...check, git: null, recentFiles: [{ path: "notes.md", modifiedAt: at }] })).toBe(true);
    expect(Value.Check(LocalHandoverCheck, { ...check, folder: null, git: null })).toBe(true);
    expect(Value.Check(LocalProjectCloneRequest, { repoUrl: "https://github.com/TokenkingOS/Chat_Service.git", branch: "handover/chat" })).toBe(true);
    expect(Value.Check(LocalProjectCloneRequest, { repoUrl: "git@github.com:TokenkingOS/Chat_Service.git" })).toBe(true);
    for (const repoUrl of ["file:///C:/secret", "ext::sh -c touch% /tmp/x", "--upload-pack=x", "C:/repo"]) expect(Value.Check(LocalProjectCloneRequest, { repoUrl })).toBe(false);
    expect(Value.Check(LocalProjectCloneRequest, { repoUrl: "https://github.com/a/b.git", branch: "--orphan" })).toBe(false);
    expect(Value.Check(LocalProjectCloneResponse, { project: null, branch: null, fellBack: false })).toBe(true);
    // 云端的转交存检查结果原样、clone 用同一个地址形状（6460ec84）
    const transferClone = ProjectTransfer.properties.clone;
    expect(Value.Check(transferClone, { repoUrl: "https://github.com/TokenkingOS/Chat_Service.git", branch: "handover/chat" })).toBe(true);
    expect(Value.Check(transferClone, { repoUrl: "C:/Users/x/repo", branch: null })).toBe(false); // 本地路径拉不了：云端要给 null
    expect(Value.Check(ProjectTransfer.properties.checkResult, check)).toBe(true);
    expect(LOCAL_RUNNER_ROUTES.cloneProject).toEqual({ method: "POST", path: "/v1/projects/:projectId/clone", auth: true });
  });

  it("配对口令只在批准后出现；路由表里只有健康和配对不要口令", () => {
    expect(Value.Check(LocalPairingStatusResponse, { status: "pending" })).toBe(true);
    const open = Object.values(LOCAL_RUNNER_ROUTES).filter((r) => !r.auth).map((r) => r.path);
    expect(open).toEqual(["/v1/health", "/v1/pairings", "/v1/pairings/:pairingId"]);
  });
});
