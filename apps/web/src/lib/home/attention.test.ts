import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { attentionOf, localAsk, markMergeLater, summaryAsk, withAttention, withLocalAttention, type LocalAsk } from "./attention";
import type { SubSession, WorkHomeData } from "./types";

const ask = (patch: Partial<LocalAsk> = {}): LocalAsk => ({ status: "running", pending: 0, question: false, merge: null, ...patch });
const SID = "00000000-0000-4000-8000-0000000000a1";
const PID = "00000000-0000-4000-8000-0000000000b1";
const session = (patch: Partial<TLocalSessionSummary> = {}) => ({
  id: SID, subject: { kind: "card", cardId: "card-1" }, status: "exited", pendingPermissions: 1, pendingQuestion: null, workspace: null, updatedAt: "2026-11-11T02:00:00.000Z", ...patch,
}) as unknown as TLocalSessionSummary;
const sub = (patch: Partial<SubSession> = {}): SubSession => ({
  id: "card-1", kind: "card", letter: "A", title: "候选名商标近似初查", state: "waiting", unseen: false, waiting: "approval", queueReason: null, role: null,
  sessionId: SID, deviceId: null, autoStart: false, updatedAt: "2026-11-11T02:00:00.000Z", merge: null, holdUntil: null, ...patch,
});

// 测试环境没有 localStorage：给一个放在内存里的。
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), clear: () => store.clear() });
});

describe("这台电脑上的会话自己在等什么（第 54 条）", () => {
  it("批准只在会话还活着时算：停了、退了还挂着的批准是失效的", () => {
    expect(localAsk(ask({ status: "waiting_permission" }))).toBe("approval");
    expect(localAsk(ask({ status: "running", pending: 1 }))).toBe("approval");
    expect(localAsk(ask({ status: "exited", pending: 1 }))).toBeNull();
    expect(localAsk(ask({ status: "idle", pending: 2 }))).toBeNull();
  });
  it("提问在会话结束后作废；一轮做完停下（idle）还在问的照样算", () => {
    expect(localAsk(ask({ status: "idle", question: true }))).toBe("question");
    expect(localAsk(ask({ status: "failed", question: true }))).toBeNull();
    expect(localAsk(ask({ status: "idle" }))).toBeNull();
  });
});

describe("并成一个来源", () => {
  it("3700 的例子：云端记受阻、本机会话停了还挂着一个批准 → 等你拿主意，不是等你批准", () => {
    expect(attentionOf("verdict", ask({ status: "exited", pending: 1 }))).toBe("verdict");
  });
  it("批准、提问以这台电脑为准：云端还说在等、本机已经答过了就没有；本机先知道的照本机", () => {
    expect(attentionOf("approval", ask({ status: "running" }))).toBeNull();
    expect(attentionOf(null, ask({ status: "waiting_permission" }))).toBe("approval");
    expect(attentionOf("question", null)).toBe("question");
  });
  it("受阻时会话又在跑（补了一句、按改法在改）不算在等本人", () => {
    expect(attentionOf("verdict", ask({ status: "running" }))).toBeNull();
    expect(attentionOf("verdict", null)).toBe("verdict");
  });
  it("合回看本机的工作树：合进去了不算，点了先不合不算", () => {
    expect(attentionOf(null, ask({ status: "done", merge: "needs" }))).toBe("merge");
    expect(attentionOf("merge", ask({ status: "done", merge: "merged" }))).toBeNull();
    expect(attentionOf("merge", ask({ status: "done", merge: "later" }))).toBeNull();
    expect(attentionOf("merge", ask({ status: "done" }))).toBe("merge");
  });
  it("会话又在跑时不算在等合回", () => {
    expect(attentionOf(null, ask({ status: "running", merge: "needs" }))).toBeNull();
    expect(attentionOf("merge", ask({ status: "running" }))).toBeNull();
  });
  it("先不合记在这台浏览器上，摘要读出来就是 later", () => {
    const ws = { kind: "worktree", needsMerge: { reason: "dirty", message: "主文件夹有没提交的改动" }, mergedCommit: null } as unknown as TLocalSessionSummary["workspace"];
    expect(summaryAsk(session({ status: "done", pendingPermissions: 0, workspace: ws })).merge).toBe("needs");
    markMergeLater(SID);
    expect(summaryAsk(session({ status: "done", pendingPermissions: 0, workspace: ws })).merge).toBe("later");
  });
});

describe("左栏和「等你」照同一个来源改", () => {
  it("失效的批准：子会话不再是橙点（停了的是已停下），「等你」里那条拿掉，项目的等你跟着减", () => {
    const data = {
      projects: [{ projectId: PID, subSessions: [sub()], summary: { running: 0, waiting: 1, queued: 0, done: 0, doneToday: 0, needsYou: 2 } }],
      other: { subSessions: [], items: [] },
      waiting: [{ id: "w1", kind: "approval", sessionId: SID, projectId: PID }, { id: "w2", kind: "month", sessionId: null, projectId: PID }],
    } as unknown as WorkHomeData;
    const next = withLocalAttention(data, [session()]);
    expect(next.projects[0]!.subSessions[0]).toMatchObject({ state: "waiting", waiting: null });
    expect(next.waiting.map((item) => item.id)).toEqual(["w2"]);
    expect(next.projects[0]!.summary.needsYou).toBe(1);
  });
  it("这台电脑上没有这个会话：照云端原样", () => {
    const data = { projects: [], other: { subSessions: [sub({ waiting: "verdict" })], items: [] }, waiting: [] } as unknown as WorkHomeData;
    expect(withLocalAttention(data, [session({ id: "00000000-0000-4000-8000-0000000000a2", subject: { kind: "card", cardId: "other" } } as Partial<TLocalSessionSummary>)])).toBe(data);
  });
  it("自由子会话做完一轮没能合回（本机 needsMerge，云端不知道）：「等你」里加一条合回，项目的等你跟着加；本机没在等的不加", () => {
    const ws = { kind: "worktree", baseBranch: "main", needsMerge: { reason: "dirty", message: "主文件夹里有没提交的改动，提交或收起来再合" }, mergedCommit: null } as unknown as TLocalSessionSummary["workspace"];
    const free = sub({ id: "topic-1", kind: "topic", free: true, state: "waiting", waiting: null, letter: "B", title: "给 rules.js 补单元测试" });
    const data = {
      projects: [{ projectId: PID, subSessions: [free], summary: { running: 0, waiting: 1, queued: 0, done: 0, doneToday: 0, needsYou: 0 } }],
      other: { subSessions: [], items: [] },
      waiting: [],
    } as unknown as WorkHomeData;
    const local = session({ subject: { kind: "topic", topicId: "topic-1" }, status: "idle", pendingPermissions: 0, workspace: ws } as Partial<TLocalSessionSummary>);
    const next = withLocalAttention(data, [local]);
    expect(next.projects[0]!.subSessions[0]).toMatchObject({ state: "waiting", waiting: "merge" });
    expect(next.waiting).toEqual([expect.objectContaining({
      id: "merge:topic:topic-1", kind: "merge", title: "没能自动合回", source: "给 rules.js 补单元测试 · 主文件夹里有没提交的改动，提交或收起来再合",
      open: { kind: "topic", id: "topic-1" }, projectId: PID, sessionId: SID, letter: "B", answer: "inline_local",
    })]);
    expect(next.projects[0]!.summary.needsYou).toBe(1);
    // 合回了（或点了先不合）：不再加
    const merged = { ...ws, needsMerge: undefined } as unknown as TLocalSessionSummary["workspace"];
    expect(withLocalAttention(data, [{ ...local, workspace: merged }]).waiting).toEqual([]);
    // 又在跑了：不挂等你合回，不加等你数
    const busy = withLocalAttention(data, [{ ...local, status: "running" }]);
    expect(busy.waiting).toEqual([]);
    expect(busy.projects[0]!.summary.needsYou).toBe(0);
  });
  it("批准作废、会话还在跑：左栏回到在跑", () => {
    expect(withAttention(sub(), [session({ status: "running", pendingPermissions: 0 })])).toMatchObject({ state: "running", waiting: null });
  });
});
