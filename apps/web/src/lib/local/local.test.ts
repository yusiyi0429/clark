import { describe, expect, it } from "vitest";
import type { TLocalSessionEvent } from "@warmap/contracts";
import { parseSse } from "./client";
import { phaseOf } from "./connection";
import { createMockRunner } from "./mock";
import { EMPTY_VIEW, foldEvent, foldEvents, localWait, planStep } from "./sessionView";

describe("事件流（fetch 读 SSE）", () => {
  it("按空行切事件，心跳注释跳过，没收完的半段留到下一次", () => {
    const first = parseSse(": ka\n\nid: 1\ndata: {\"seq\":1}\n\nid: 2\ndata: {\"se");
    expect(first.events).toEqual([{ id: 1, data: "{\"seq\":1}" }]);
    const second = parseSse(first.rest + "q\":2}\r\n\r\n");
    expect(second.events).toEqual([{ id: 2, data: "{\"seq\":2}" }]);
    expect(second.rest).toBe("");
  });
});

describe("连本机的三种浏览器授权结果", () => {
  it("连上了：有口令是 ready，没口令是 unpaired", () => {
    expect(phaseOf({ health: "ok", tokenValid: true, permission: "granted" })).toBe("ready");
    expect(phaseOf({ health: "ok", tokenValid: false, permission: "granted" })).toBe("unpaired");
  });
  it("浏览器在问（请求挂着、授权是 prompt）是等授权；拒过是 blocked，不当成没装", () => {
    expect(phaseOf({ health: "waiting", permission: "prompt" })).toBe("prompt");
    expect(phaseOf({ health: "failed", permission: "denied" })).toBe("blocked");
  });
  it("浏览器放行了还连不上（或浏览器不报授权状态）：没装或没开", () => {
    expect(phaseOf({ health: "failed", permission: "granted" })).toBe("offline");
    expect(phaseOf({ health: "failed", permission: "unknown" })).toBe("offline");
  });
});

const ev = (seq: number, body: Record<string, unknown>) => ({ seq, at: `2026-11-06T10:00:${String(seq).padStart(2, "0")}Z`, sessionId: "00000000-0000-4000-8000-000000000000", ...body }) as TLocalSessionEvent;

describe("把本机事件折成页面要画的样子", () => {
  it("重连补发的同一条只算一次；工具步骤结束后标完成", () => {
    const events = [ev(1, { type: "status", status: "running" }), ev(2, { type: "tool_call", toolUseId: "t", name: "Bash", title: "运行测试", input: {} }), ev(3, { type: "tool_result", toolUseId: "t", isError: false, preview: "ok" })];
    const view = foldEvents([...events, events[1]!]);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({ kind: "step", done: true });
    expect(foldEvent(view, events[0]!)).toBe(view);
  });
  it("标记：权限挂着 → 等你批准；停下 → 已暂停；一轮停了 → 等你回复；交回了就不算等", () => {
    const request = { requestId: "r1", toolName: "Bash", title: "运行 pnpm test", input: {}, canAllowForSession: true, requestedAt: "2026-11-06T10:00:00Z" };
    const asked = foldEvents([ev(1, { type: "status", status: "running" }), ev(2, { type: "permission_request", request }), ev(3, { type: "status", status: "waiting_permission" })]);
    expect(localWait(asked)).toBe("approval");
    const answered = foldEvents([ev(4, { type: "permission_resolved", requestId: "r1", decision: "allow", allowForSession: false }), ev(5, { type: "status", status: "running" })], asked);
    expect(answered.pending).toEqual([]);
    expect(localWait(answered)).toBeNull();
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 };
    const stopped = foldEvents([ev(6, { type: "turn_end", isError: false, text: null, durationMs: 1, usage, errorKind: "interrupted" }), ev(7, { type: "status", status: "idle" })], answered);
    expect(localWait(stopped)).toBe("paused");
    const replied = foldEvents([ev(8, { type: "user_message", text: "继续", source: "web" }), ev(9, { type: "status", status: "running" }), ev(10, { type: "turn_end", isError: false, text: "要删吗？", durationMs: 1, usage }), ev(11, { type: "status", status: "idle" })], stopped);
    expect(localWait(replied)).toBe("reply");
    expect(replied.usage.costUsd).toBeCloseTo(0.02);
    const handed = foldEvents([ev(12, { type: "handback", summary: "好了", criteria: [{ index: 1, result: "met", evidence: "x" }] })], replied);
    expect(localWait(handed)).toBeNull();
  });
  it("「第 3/6 步」取正在做的那条", () => {
    expect(planStep([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }])).toEqual({ step: 2, total: 3, text: "b" });
    expect(planStep([])).toBeNull();
    expect(EMPTY_VIEW.entries).toEqual([]);
  });
});

describe("假本机程序按脚本吐事件", () => {
  it("开工 → 三步计划 → 一次权限请求 → 一次提问 → 交回", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const seen: TLocalSessionEvent[] = [];
    const controller = new AbortController();
    void runner.watch(session.id, { after: 0, onEvent: (event) => seen.push(event), signal: controller.signal });
    const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2)); };
    await until(() => seen.some((event) => event.type === "permission_request"));
    const plan = seen.find((event) => event.type === "plan");
    expect(plan && plan.type === "plan" ? plan.entries.length : 0).toBe(3);
    const request = seen.find((event) => event.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("没有权限请求");
    await runner.decidePermission(session.id, request.request.requestId, { decision: "allow" });
    await until(() => foldEvents(seen).status === "idle");
    expect(localWait(foldEvents(seen))).toBe("reply");
    await runner.sendMessage(session.id, "删掉");
    await until(() => seen.some((event) => event.type === "handback"));
    expect(seen.map((event) => event.type)).toContain("artifact");
    expect(localWait(foldEvents(seen))).toBeNull();
    controller.abort();
  });
});
