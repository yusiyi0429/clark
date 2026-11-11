import { beforeAll, describe, expect, it } from "vitest";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CreateTopicRequest, LOCAL_RUNNER_PROTOCOL, LocalCreateSessionRequest, LocalSyncBatchRequest, ResearchTopicView, SubSession, WorkerQueueReason } from "../src/index.js";

/** 第 68 条自由子会话（项目下的「+」）：专题带 free，不加新的会话种类；普通文件夹被占着时排队写清在等谁。新字段都可选。 */

const uuid = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";
const deviceId = "0d2f9a1e-7c44-4b5e-8f3a-2a9e6c1d7b55";
const at = "2026-11-11T08:00:00.000Z";

beforeAll(() => {
  FormatRegistry.Set("uuid", (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)) && /T/.test(v));
});

describe("自由子会话（第 68 条）", () => {
  it("建：free + projectId + 第一句话，不带标题；老的建法照旧合法", () => {
    expect(Value.Check(CreateTopicRequest, { free: true, projectId: uuid, firstMessage: "把 docs 里的周报改成表格" })).toBe(true);
    expect(Value.Check(CreateTopicRequest, { title: "竞品调研" })).toBe(true);
    expect(Value.Check(CreateTopicRequest, { free: false, projectId: uuid, firstMessage: "x" })).toBe(false);
  });

  it("本机开工带 free（protocol 4 起）；只能是 true", () => {
    expect(LOCAL_RUNNER_PROTOCOL).toBe(4);
    const req = { subject: { kind: "topic", topicId: uuid, projectId: uuid }, title: "把周报改成表格", firstMessage: "把 docs 里的周报改成表格" };
    expect(Value.Check(LocalCreateSessionRequest, { ...req, free: true })).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, req)).toBe(true);
    expect(Value.Check(LocalCreateSessionRequest, { ...req, free: false })).toBe(false);
  });

  it("排队等普通文件夹：本机报占着它的是谁，云端给 folder_busy 和字母", () => {
    const status = { status: "queued", title: "把周报改成表格", agent: "claude-code", modelLabel: "Opus", queuePosition: 1, heldBy: { kind: "card", id: uuid, title: "改登录页" } };
    const batch = { deviceId, runnerVersion: "0.9.0", slots: { max: 2, running: 1, queued: 1 },
      items: [{ key: `${deviceId}:${uuid}:3`, sessionId: uuid, subject: { kind: "topic", topicId: uuid, projectId: uuid }, occurredAt: at, type: "status", data: status }] };
    expect(Value.Check(LocalSyncBatchRequest, batch)).toBe(true);
    expect(Value.Check(WorkerQueueReason, "folder_busy")).toBe(true);
    const sub = { id: uuid, kind: "topic", letter: "C", title: "把周报改成表格", state: "queued", unseen: false, waiting: null, queueReason: "folder_busy", role: null,
      sessionId: uuid, deviceId, autoStart: false, updatedAt: at, merge: null, holdUntil: null, free: true, heldBy: { kind: "card", id: uuid, letter: "B", title: "改登录页" } };
    expect(Value.Check(SubSession, sub)).toBe(true);
    expect(Value.Check(SubSession, { ...sub, free: undefined, heldBy: undefined, queueReason: "slot" })).toBe(true);
  });

  it("专题视图带 free；不带的照旧", () => {
    const topic = { id: uuid, title: "把周报改成表格", status: "active", planTaskId: null, missionId: null, role: null, createdAt: at, updatedAt: at, lastVersionAt: null, latestVersion: null, run: null };
    expect(Value.Check(ResearchTopicView, { ...topic, free: true })).toBe(true);
    expect(Value.Check(ResearchTopicView, topic)).toBe(true);
  });
});
