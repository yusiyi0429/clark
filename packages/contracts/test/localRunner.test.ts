import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  LocalCreateSessionRequest, LocalModelProfileUpsert, LocalModelProfile, LocalPermissionDecisionRequest, LocalSessionEvent,
  LocalSyncBatchRequest, LocalPairingStatusResponse, LOCAL_RUNNER_ROUTES,
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
    expect(Value.Check(LocalSessionEvent, { ...base, type: "plan", entries: [{ content: "写测试", status: "in_progress" }] })).toBe(true);
    expect(Value.Check(LocalSessionEvent, { ...base, type: "assistant_text", text: "好", raw: {} })).toBe(false);
    expect(Value.Check(LocalSessionEvent, { ...base, seq: 0, type: "assistant_text", text: "好" })).toBe(false);
  });

  it("同步载荷带幂等键；产出物有大小上限；不收未知类型", () => {
    const item = { key: `${deviceId}:${sessionId}:7`, sessionId, subject: { kind: "card", cardId: "task-1" }, occurredAt: "2026-11-06T02:00:00.000Z" };
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", items: [
      { ...item, type: "status", data: { status: "running", title: "修登录页", agent: "claude-code", modelLabel: "订阅" } },
      { ...item, type: "cost", data: { modelLabel: "订阅", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } } },
    ] })).toBe(true);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", items: [] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", items: [{ ...item, type: "repo_files", data: {} }] })).toBe(false);
    expect(Value.Check(LocalSyncBatchRequest, { deviceId, runnerVersion: "0.1.0", items: [{ ...item, type: "artifact", data: {
      artifactId: "a1", title: "方案", fileName: "a.md", mimeType: "text/markdown", size: 11 * 1024 * 1024, sha256: "0".repeat(64), contentBase64: "",
    } }] })).toBe(false);
  });

  it("配对口令只在批准后出现；路由表里只有健康和配对不要口令", () => {
    expect(Value.Check(LocalPairingStatusResponse, { status: "pending" })).toBe(true);
    const open = Object.values(LOCAL_RUNNER_ROUTES).filter((r) => !r.auth).map((r) => r.path);
    expect(open).toEqual(["/v1/health", "/v1/pairings", "/v1/pairings/:pairingId"]);
  });
});
