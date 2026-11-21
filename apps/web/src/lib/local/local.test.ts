import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TLocalSessionEvent } from "@warmap/contracts";
import { parseSse } from "./client";
import { PROMPT_WAIT_MS, needsRelink, pairedElsewhere, phaseOf, probeRunner, singleFlight } from "./connection";
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
  it("授权是 prompt 但很快就失败（浏览器根本没问，本机程序没开）：离线，不是等授权；挂了很久才失败（本人把框关了）还是等授权", () => {
    expect(phaseOf({ health: "failed", permission: "prompt", elapsedMs: 2060 })).toBe("offline");
    expect(phaseOf({ health: "failed", permission: "prompt" })).toBe("offline");
    expect(phaseOf({ health: "failed", permission: "prompt", elapsedMs: PROMPT_WAIT_MS + 1 })).toBe("prompt");
  });
});

describe("探一次本机程序", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const never = () => new Promise<never>(() => undefined);
  const prompt = async () => "prompt" as const;

  it("很快失败（Windows 上连关着的端口约 2 秒）：离线，中途不亮等授权", async () => {
    const waiting = vi.fn();
    const result = probeRunner(() => new Promise((_, reject) => setTimeout(() => reject(new TypeError("Failed to fetch")), 2060)), waiting, prompt);
    await vi.advanceTimersByTimeAsync(2100);
    await expect(result).resolves.toEqual({ phase: "offline" });
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MS);
    expect(waiting).not.toHaveBeenCalled();
  });
  it("一直挂着：过了 PROMPT_WAIT_MS 亮等授权；本人把框关了（挂很久后失败）还是等授权", async () => {
    const waiting = vi.fn();
    let fail!: (cause: Error) => void;
    const result = probeRunner(() => new Promise((_, reject) => { fail = reject; }), waiting, prompt);
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MS - 100);
    expect(waiting).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(waiting).toHaveBeenCalledWith("prompt");
    await vi.advanceTimersByTimeAsync(5000);
    fail(new TypeError("Failed to fetch"));
    await expect(result).resolves.toEqual({ phase: "prompt" });
  });
  it("授权是 denied：被拦截（挂着时也是）", async () => {
    const waiting = vi.fn();
    void probeRunner(never, waiting, async () => "denied");
    await vi.advanceTimersByTimeAsync(PROMPT_WAIT_MS + 1);
    expect(waiting).toHaveBeenCalledWith("blocked");
    await expect(probeRunner(() => Promise.reject(new TypeError("Failed to fetch")), vi.fn(), async () => "denied")).resolves.toEqual({ phase: "blocked" });
  });
  it("连上了：交回 health 的结果", async () => {
    await expect(probeRunner(async () => ({ tokenValid: true }), vi.fn(), prompt)).resolves.toEqual({ health: { tokenValid: true } });
  });
  it("重试：有一次挂着时平时再叫是等它，点重试另起一次真的再探，旧那次作废", async () => {
    const flight = singleFlight();
    const health = vi.fn(never);
    const seen: boolean[] = [];
    let release!: () => void;
    const run = (latest: () => boolean) => { void health(); return new Promise<void>((done) => { release = () => { seen.push(latest()); done(); }; }); };
    void flight(run);
    void flight(run);
    expect(health).toHaveBeenCalledTimes(1);
    const firstRelease = release;
    const second = flight(run, true);
    expect(health).toHaveBeenCalledTimes(2);
    firstRelease();
    release();
    await second;
    expect(seen).toEqual([false, true]);
    void flight(run);
    expect(health).toHaveBeenCalledTimes(3);
  });
});

describe("连本机：换账号", () => {
  it("同一台电脑换了账号：本机关联的是别人（按人员 id）就按没配对算；没关联、老关联、或不知道本人是谁时不算别人", () => {
    const linked = (personId: string | null, isLinked = true) => ({ cloud: { linked: isLinked, personId } });
    expect(pairedElsewhere(linked("sun-mingze"), "browser-dri")).toBe(true);
    expect(pairedElsewhere(linked("sun-mingze"), "sun-mingze")).toBe(false);
    expect(pairedElsewhere(linked(null, false), "browser-dri")).toBe(false);
    expect(pairedElsewhere(linked("sun-mingze"), null)).toBe(false);
    // 老关联（没记下是谁）：不当别人，连接页再给一次「关联」。
    expect(pairedElsewhere(linked(null), "browser-dri")).toBe(false);
    expect(needsRelink(linked(null))).toBe(true);
    expect(needsRelink(linked("sun-mingze"))).toBe(false);
    expect(needsRelink(linked(null, false))).toBe(false);
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
