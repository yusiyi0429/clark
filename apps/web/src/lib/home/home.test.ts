import { describe, expect, it } from "vitest";
import type { THomePlanResponse, TWorkerItem } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { toWorker, type Worker } from "@/lib/work/workers";
import type { MemberNotification } from "@/components/member/useMemberHome";
import {
  deriveFeed, deriveWorkHome, duration, groupBackground, inScope, localBackground, mergeBackground, routeText, statusLine, waitingHref, workerBackground,
} from "./derive";
import type { BackgroundItem } from "./types";
import type { CardItem } from "@/lib/board/cards";

const ROLE = { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" as const };
const item = (extra: Partial<TWorkerItem>): TWorkerItem => ({
  key: "card:c1", kind: "card", cardId: "c1", topicId: null, title: "接上首页数据", role: ROLE, workerNo: 1,
  task: { id: "t1", name: "11/30 上线 V2" }, mission: null, step: null,
  resource: { where: "local", deviceId: null, deviceName: "ThinkPad", modelLabel: "Sonnet" }, startedAt: "2026-11-07T04:00:00Z", elapsedSeconds: 60,
  finishedAt: null, cost: null, stage: "doing", wait: null, needsYou: false, queueReason: null, queuePosition: null, git: null, waitingFor: [], ...extra,
});
const session = (extra: Partial<TLocalSessionSummary>): TLocalSessionSummary => ({
  id: "00000000-0000-4000-8000-0000000000a1", subject: { kind: "plan", taskId: "t1" }, title: "拆卡", agent: "claude-code", modelProfileId: "subscription", modelLabel: "Sonnet",
  cwd: "C:\\w", status: "running", includePersonalConfig: false, createdAt: "2026-11-07T04:00:00Z", updatedAt: "2026-11-07T04:01:00Z", lastSeq: 3, pendingPermissions: 0,
  queuePosition: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }, ...extra,
});
const worker = (extra: Partial<TWorkerItem>, sessions: TLocalSessionSummary[] = []): Worker => toWorker(item(extra), { sessions, cards: new Map(), deviceName: null });
const plan = {
  period: "2026-11", today: "2026-11-07", gates: [{ missionId: "m1", date: "2026-11-30" }, { missionId: "m1", date: "2026-11-20" }],
  missions: [{ missionId: "m1", code: "M1", title: "天枢 11 月", cardId: null, color: "#000", world: null }, { missionId: "m2", code: "M2", title: "空的", cardId: null, color: "#000", world: null }],
  tasks: [
    { taskId: "t1", missionId: "m1", name: "11/30 上线 V2", doneDefinition: "本机派活、岗位与本机验收跑通", criteria: ["本机派活跑通", "验收员逐条判"] },
    { taskId: "t2", missionId: "m1", name: "11/18 上线 V1", doneDefinition: null, criteria: ["约定、对表与参考评审"], deliverable: { status: "delivered", score: null, version: 2 } },
  ],
} as unknown as THomePlanResponse;
const WORKTREE = { kind: "worktree" as const, folder: "C:\\w", path: "C:\\w\\.wt\\c5", branch: "tianshu/c5", baseBranch: "main", baseCommit: "a".repeat(40), mergedCommit: null };
/** 本机没能自动合回、等本人合（「验收过就合回」关着）。 */
const HOLD = { reason: "auto_merge_off" as const, message: "「验收过就合回」关着，等你合" };
/** 看板上的卡（交给 Agent 做的，带最近一次交回）。 */
const boardCard = (id: string, title: string, handback: Record<string, unknown>, criterion: number | null = null): CardItem => ({
  id, title, updatedAt: "2026-11-06T05:00:00Z", card: { executor: "claude_code", role: null, criterion: criterion ? { index: criterion, text: "x" } : null, handback: {
    id: `hb-${id}`, attempt: 1, status: "done", outcome: "pass", met: 2, total: 2, headline: null, returnText: null, returnedAt: null, overruled: false,
    createdAt: "2026-11-06T04:30:00Z", finishedAt: "2026-11-06T05:00:00Z", git: null, ...handback,
  } },
}) as unknown as CardItem;
const cardSessionWith = (cardId: string, workspace: { mergedCommit?: string; needsMerge?: typeof HOLD }) => session({
  id: `00000000-0000-4000-8000-${cardId.padStart(12, "0").slice(-12).replace(/[^0-9a-f]/g, "0")}`, subject: { kind: "card", cardId }, status: "exited",
  workspace: { ...WORKTREE, ...workspace },
});
const withHandback = (base: Worker, handback: Record<string, unknown>, criterion: number | null = null): Worker => ({
  ...base, item: { id: base.cardId, createdAt: "2026-11-07T03:00:00Z", card: { criterion: criterion ? { index: criterion, text: "x" } : null, handback: {
    id: `hb-${base.cardId}`, attempt: 1, status: "done", outcome: "pass", met: 2, total: 2, headline: null, returnText: null, returnedAt: null, overruled: false,
    createdAt: "2026-11-07T04:30:00Z", finishedAt: "2026-11-07T05:00:00Z", git: null, ...handback,
  } } } as unknown as Worker["item"],
});

describe("新首页的数据（B 的 work-home 没上时照契约的形状拼）", () => {
  const workers = [
    worker({ key: "card:c1", cardId: "c1", wait: "approval" }),
    worker({ key: "card:c2", cardId: "c2", title: "写测试", stage: "todo", queueReason: "slot" }),
    worker({ key: "card:c3", cardId: "c3", title: "改样式", stage: "done", finishedAt: "2026-11-07T05:00:00Z" }),
    worker({ key: "card:c4", cardId: "c4", title: "接口对齐", wait: "review_failed" }),
    worker({ key: "topic:tp1", kind: "topic", cardId: null, topicId: "tp1", title: "起名字", task: null }),
    worker({ key: "verify:c3", kind: "verify", cardId: "c3", title: "改样式", stage: "done", finishedAt: "2026-11-07T05:02:00Z" }),
  ];
  const data = deriveWorkHome({ plan, workers, boards: {}, proposals: [], merges: [], deviceId: null, notices: {
    notifications: [{ id: "n1", kind: "meeting_card_pending", text: "周会记录待确认", source: "周会", objectType: "meeting", objectId: "mt1", createdAt: "2026-11-07T01:00:00Z", readAt: null } as MemberNotification],
    rounds: [], unreadThreads: [{ objectType: "issue", objectId: "i1", title: "验收口径", unread: 2, href: "/me/issues/i1" }], unreadMissionGroups: [],
  } });

  it("Task 下是能对话的子会话（卡、专题），规划员和验收员不算；等你排在前面，第一次没过仍是进行中（重做中）；不归 Task 的进「其他」；本月的 Mission 没有 Task 也列（界面不画）", () => {
    expect(data.period).toBe("2026-11");
    expect(data.missions.map((mission) => [mission.missionId, mission.period, mission.tasks.length])).toEqual([["m1", "2026-11", 2], ["m2", "2026-11", 0]]);
    const v2 = data.missions[0]!.tasks[0]!;
    expect(v2.subSessions.map((sub) => [sub.id, sub.state, sub.waiting, sub.queueReason])).toEqual([
      ["c1", "waiting", "approval", null], ["c4", "running", null, null], ["c2", "queued", null, "slot"], ["c3", "done", null, null],
    ]);
    expect(v2.pipeline).toEqual({ conversationId: null, scope: "plan-task:t1" });
    expect(v2.subtitle).toBe("11/20 验收");
    expect(data.missions[0]!.tasks[1]!.completedAt).not.toBeNull();
    expect(data.other.subSessions).toEqual([expect.objectContaining({ id: "tp1", kind: "topic" })]);
  });

  it("首页一行现状：按紧急程度等你、进行中（没过的在自动重做）、已排队、今天完成，最多三段；交付了是已完成；规划员在拆写拆卡中；什么都没有是未开始", () => {
    const [v2, v1] = data.missions[0]!.tasks;
    expect(v2!.summary).toMatchObject({ running: 1, waiting: 1, queued: 1, done: 1, doneToday: 1, needsYou: 1 });
    expect(statusLine(v2!)).toBe("等你 1 · 进行中 1 · 已排队 1");
    expect(statusLine(v1!)).toBe("已完成");
    const idle = { ...v2!, completedAt: null, subSessions: [], summary: { ...v2!.summary, queued: 0, doneToday: 0, needsYou: 0 } };
    expect(statusLine({ ...idle, planning: true })).toBe("拆卡中");
    expect(statusLine({ ...idle, planning: false })).toBe("未开始");
  });

  it("等你：子会话的批准、会议记录待确认、群里的新消息；去哪儿看由 open 映射到路由；受阻去 Task 管线；第一次没过自动重做，不在这里", () => {
    expect(data.waiting.map((entry) => [entry.kind, waitingHref(entry)])).toEqual([
      ["approval", "/me/work/cards/c1"], ["meeting", "/me/meetings/mt1"], ["thread", "/me/issues/i1"],
    ]);
    expect(data.waiting[0]).toMatchObject({ title: "等你批准", source: "接上首页数据 · 11/30 上线 V2", taskId: "t1", open: { kind: "card", id: "c1" } });
    const blocked = deriveWorkHome({ plan, workers: [worker({ key: "card:c9", cardId: "c9", wait: "blocked" })], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(blocked.waiting.map((entry) => [entry.kind, entry.title, waitingHref(entry)])).toEqual([["verdict", "受阻", "/me/work/tasks/t1"]]);
  });

  it("验收过了、本机没能自动合回（needsMerge）：子会话是等你合回，等你里一条「合进 main」；本机还在自己合的不算等你；合回了折进已完成", () => {
    const passed = { ...worker({ key: "card:c5", cardId: "c5", title: "greet", stage: "done", finishedAt: "2026-11-07T05:00:00Z" }), workspace: { ...WORKTREE, needsMerge: HOLD } };
    const home = deriveWorkHome({ plan, workers: [passed], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(home.missions[0]!.tasks[0]!.subSessions[0]).toMatchObject({ state: "waiting", waiting: "merge", merge: { state: "needs_merge", baseBranch: "main", reason: "auto_merge_off" } });
    expect(home.waiting).toEqual([expect.objectContaining({ kind: "merge", title: "合进 main", open: { kind: "card", id: "c5" } })]);
    const merging = deriveWorkHome({ plan, workers: [{ ...passed, workspace: WORKTREE }], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(merging.missions[0]!.tasks[0]!.subSessions[0]).toMatchObject({ state: "done", waiting: null, merge: null });
    expect(merging.waiting).toEqual([]);
    const merged = deriveWorkHome({ plan, workers: [{ ...passed, workspace: { ...WORKTREE, mergedCommit: "b".repeat(40) } }], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(merged.missions[0]!.tasks[0]!.subSessions[0]).toMatchObject({ state: "done", waiting: null, merge: { state: "merged", baseBranch: "main" } });
    expect(merged.waiting).toEqual([]);
  });
});

describe("树上的卡：worker 列表只有今天完成的，看板补上之前过的；验收中的卡照样在树上", () => {
  it("昨天过了、合回了的卡折进已完成；昨天过了、这台电脑上没合回的还在等你合", () => {
    const boards = { t1: { plan: null, cards: [boardCard("c7", "昨天的", {}), boardCard("c8", "没合的", {})] } };
    const home = deriveWorkHome({ plan, workers: [], boards, proposals: [], merges: [], notices: null, deviceId: "dev-1",
      sessions: [cardSessionWith("c7", { mergedCommit: "b".repeat(40) }), cardSessionWith("c8", { needsMerge: HOLD })] });
    const subs = home.missions[0]!.tasks[0]!.subSessions;
    expect(subs.map((sub) => [sub.id, sub.state, sub.waiting])).toEqual([["c8", "waiting", "merge"], ["c7", "done", null]]);
    expect(home.waiting).toEqual([expect.objectContaining({ kind: "merge", title: "合进 main", open: { kind: "card", id: "c8" }, taskId: "t1", deviceId: "dev-1" })]);
  });

  it("验收中云端只列验收员那条：卡在树上是进行中；卡本身也在列表里时不重复", () => {
    const verifying = worker({ key: "verify:c9", kind: "verify", cardId: "c9", title: "接口" });
    const only = deriveWorkHome({ plan, workers: [verifying], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(only.missions[0]!.tasks[0]!.subSessions).toEqual([expect.objectContaining({ id: "c9", kind: "card", state: "running" })]);
    const both = deriveWorkHome({ plan, workers: [verifying, worker({ key: "card:c9", cardId: "c9", title: "接口", wait: "approval" })], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(both.missions[0]!.tasks[0]!.subSessions.map((sub) => [sub.id, sub.state])).toEqual([["c9", "waiting"]]);
  });

  it("合不回、但树上没有那张卡的，照样在等你里", () => {
    const home = deriveWorkHome({ plan, workers: [], boards: {}, proposals: [], notices: null, deviceId: null,
      merges: [{ sessionId: "s-1", cardId: "c-old", title: "旧卡", text: "主文件夹有没提交的改动" }] });
    expect(home.waiting).toEqual([expect.objectContaining({ kind: "merge", title: "合并不了", open: { kind: "card", id: "c-old" } })]);
  });
});

describe("Task 管线里的验收行（B 的 feed 没上时由看板上的卡拼）", () => {
  const base = (cardId: string, title: string, extra: Partial<TWorkerItem> = {}) => worker({ key: `card:${cardId}`, cardId, title, stage: "done", finishedAt: "2026-11-07T05:00:00Z", ...extra });

  it("过了一行从看板上的卡拼（昨天过的也在），带合回结果；受阻从还在做的卡拼；第一次没过、推翻了的不出", () => {
    const items = deriveFeed({ criteria: ["a", "b"], merges: [], sessions: [cardSessionWith("c1", { mergedCommit: "b".repeat(40) })],
      cards: [boardCard("c1", "greet", {}), boardCard("c4", "推翻的", { overruled: true }), boardCard("c3", "样式", { outcome: "fail" })],
      workers: [
        withHandback(base("c2", "接口", { stage: "doing", wait: "blocked" }), { outcome: "fail", returnText: "补上 404", finishedAt: "2026-11-07T05:10:00Z" }),
        withHandback(base("c3", "样式", { stage: "doing", wait: "review_failed" }), { outcome: "fail" }),
      ] });
    expect(items.map((entry) => entry.kind)).toEqual(["card_passed", "card_blocked"]);
    expect(items[0]).toMatchObject({ cardId: "c1", met: 2, total: 2, merge: { state: "merged", baseBranch: "main" } });
    expect(items[1]).toMatchObject({ cardId: "c2", handbackId: "hb-c2", fix: "补上 404" });
  });

  it("受阻已经按改法送回去（returnedAt）的不再问", () => {
    const items = deriveFeed({ criteria: [], merges: [], cards: [],
      workers: [withHandback(base("c2", "接口", { stage: "doing", wait: "blocked" }), { outcome: "fail", returnedAt: "2026-11-07T05:20:00Z" })] });
    expect(items).toEqual([]);
  });

  it("约定的每一条都有过了的卡（含本人「仍然通过」的），问交给认可人；只差一条不问", () => {
    const items = deriveFeed({ criteria: ["a", "b"], merges: [], workers: [], cards: [
      boardCard("c1", "一", {}, 1),
      boardCard("c2", "二", { outcome: "fail", overruled: true, finishedAt: "2026-11-07T06:00:00Z" }, 2),
    ] });
    expect(items.map((entry) => entry.kind)).toEqual(["card_passed", "card_passed", "criteria_met"]);
    expect(items[2]).toMatchObject({ met: 2, total: 2 });
    expect(deriveFeed({ criteria: ["a", "b"], merges: [], workers: [], cards: [boardCard("c1", "一", {}, 1)] }).map((entry) => entry.kind)).toEqual(["card_passed"]);
  });
});

describe("后台任务", () => {
  const planner = session({});
  const card = session({
    id: "00000000-0000-4000-8000-0000000000b2", subject: { kind: "card", cardId: "c1" }, title: "接上首页数据",
    background: [
      { id: "t-1", title: "读相关代码", kind: "subagent", state: "done", startedAt: "2026-11-07T04:02:00Z", finishedAt: "2026-11-07T04:03:00Z", stoppable: false },
      { id: "t-2", title: "pnpm test --watch", kind: "command", state: "running", startedAt: "2026-11-07T04:04:00Z", finishedAt: null, stoppable: true },
    ],
  });
  const verifier = session({ id: "00000000-0000-4000-8000-0000000000c3", subject: { kind: "verify", cardId: "c3" }, title: "验收：改样式", status: "done" });
  const here = localBackground({ sessions: [planner, card, verifier], deviceId: "dev-1", canStop: true, today: "2026-11-07", taskOfCard: (cardId) => (cardId === "c1" || cardId === "c3" ? "t1" : null) });

  it("这台电脑上的：规划员写拆卡，验收员写验收「卡」，会话里的子 agent、后台命令各一条（id 和云端同一套），卡的会话本身不是", () => {
    expect(here.map((entry) => [entry.id, entry.kind, entry.title, entry.state])).toEqual([
      [`plan:${planner.id}`, "plan", "拆卡", "running"],
      [`bg:${card.id}:t-1`, "subagent", "读相关代码", "done"],
      [`bg:${card.id}:t-2`, "command", "pnpm test --watch", "running"],
      [`verify:${verifier.id}`, "verify", "验收「改样式」", "done"],
    ]);
    expect(here[2]).toMatchObject({ stoppable: true, sessionId: card.id, itemId: "t-2", taskId: "t1", cardId: "c1", deviceId: "dev-1" });
    expect(localBackground({ sessions: [card], deviceId: null, canStop: false, today: "2026-11-07", taskOfCard: () => null }).every((entry) => !entry.stoppable)).toBe(true);
  });

  it("结束了的只列今天（公司时区）结束的；交完收工（done）是完成，退出了（停下、强停）是已停止；专题会话里的挂到它所在的 Task", () => {
    const old = session({ id: "00000000-0000-4000-8000-0000000000d4", subject: { kind: "verify", cardId: "c3" }, title: "验收：旧", status: "done", updatedAt: "2026-11-05T04:00:00Z" });
    const lateNight = session({ id: "00000000-0000-4000-8000-0000000000d5", subject: { kind: "plan", taskId: "t1" }, status: "done", updatedAt: "2026-11-06T22:30:00Z" });
    const killed = session({ id: "00000000-0000-4000-8000-0000000000d7", subject: { kind: "verify", cardId: "c3" }, title: "验收：停掉的", status: "exited" });
    const topic = session({ id: "00000000-0000-4000-8000-0000000000d6", subject: { kind: "topic", topicId: "tp1" }, title: "起名字",
      background: [{ id: "x", title: "查资料", kind: "subagent", state: "running", startedAt: "2026-11-07T04:00:00Z", finishedAt: null, stoppable: true }] });
    const items = localBackground({ sessions: [old, lateNight, verifier, killed, topic], deviceId: null, canStop: true, today: "2026-11-07",
      taskOfCard: () => null, taskOfTopic: (topicId) => (topicId === "tp1" ? "t1" : null) });
    expect(items.map((entry) => [entry.id.split(":")[0], entry.title, entry.state])).toEqual([
      ["plan", "拆卡", "done"], ["verify", "验收「改样式」", "done"], ["verify", "验收「停掉的」", "stopped"], ["bg", "查资料", "running"],
    ]);
    expect(inScope(items, "task:t1").map((entry) => entry.title)).toEqual(["拆卡", "查资料"]);
  });

  it("跟着展示区取范围；云端的和这台电脑上的合在一起，同一个 id 以这台电脑为准", () => {
    expect(inScope(here, "task:t1")).toHaveLength(4);
    expect(inScope(here, "card:c1").map((entry) => entry.kind)).toEqual(["subagent", "command"]);
    expect(inScope(here, "card:c3").map((entry) => entry.kind)).toEqual(["verify"]);
    const cloud: BackgroundItem[] = [{ ...here[0]!, state: "queued", stoppable: false }, { ...here[0]!, id: "plan:other", title: "拆卡", deviceId: "dev-2" }];
    expect(mergeBackground(cloud, here).filter((entry) => entry.kind === "plan").map((entry) => [entry.id, entry.state])).toEqual([["plan:other", "running"], [`plan:${planner.id}`, "running"]]);
    const topicRow = { ...here[1]!, taskId: null };
    expect(mergeBackground([{ ...here[1]!, taskId: "t9" }], [topicRow])[0]).toMatchObject({ taskId: "t9", state: "done" });
    const elsewhere = workerBackground([worker({ key: "verify:c9", kind: "verify", cardId: "c9", title: "别处的卡" })]);
    expect(elsewhere).toEqual([expect.objectContaining({ id: "verify:c9", title: "验收「别处的卡」", stoppable: false })]);
  });

  it("进行中（排着的在后）和已完成两组，失败、停了的算已完成；用时", () => {
    const row = (id: string, state: BackgroundItem["state"], finishedAt: string | null = null): BackgroundItem => ({ ...here[0]!, id, state, finishedAt });
    const groups = groupBackground([row("a", "queued"), row("b", "running"), row("c", "failed", "2026-11-07T04:00:30Z"), row("d", "stopped", "2026-11-07T04:01:00Z")]);
    expect(groups.running.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(groups.finished.map((entry) => entry.id)).toEqual(["d", "c"]);
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T04:00:30Z")).toBe("30 秒");
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T04:12:10Z")).toBe("12 分");
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T05:05:00Z")).toBe("1 小时 5 分");
  });
});

describe("首页输入框的「自动」（B 的 /route 没上时，规则相同）", () => {
  const tasks = plan.tasks;
  it("只在管线之间选：提到 Task 名或标准里四个字以上的词就发给那件 Task；都没提到、或提到好几件，交给伙伴", () => {
    expect(routeText("11/18 上线 V1 那件还差什么", tasks)).toEqual({ taskId: "t2" });
    expect(routeText("验收员逐条判的口径再看一下", tasks)).toEqual({ taskId: "t1" });
    expect(routeText("今天下午有什么会", tasks)).toBe("main");
    expect(routeText("11/18 上线 V1 和 11/30 上线 V2 哪个先", tasks)).toBe("main");
  });
});
