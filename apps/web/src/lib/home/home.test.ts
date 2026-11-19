import { describe, expect, it } from "vitest";
import type { THomePlanResponse, TWorkerItem } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { toWorker, type Worker } from "@/lib/work/workers";
import type { MemberNotification } from "@/components/member/useMemberHome";
import {
  backgroundModel, monthTaskSubs, deriveFeed, deriveWorkHome, duration, gateLabel, taskGateLabel, toSubSession, groupBackground, inScope, localBackground, mergeBackground, emptyMonth, queueText, routeText, sortWaiting, statusLine, waitingHref, workerBackground,
} from "./derive";
import type { BackgroundItem, SubSession, WaitingItem } from "./types";
import type { CardItem } from "@/lib/board/cards";

const ROLE = { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" as const };
const item = (extra: Partial<TWorkerItem>): TWorkerItem => ({
  key: "card:c1", kind: "card", cardId: "c1", topicId: null, title: "接上首页数据", role: ROLE, workerNo: 1,
  task: { id: "t1", name: "11/30 上线 V2" }, mission: null, step: null,
  resource: { where: "local", deviceId: null, deviceName: "ThinkPad", modelLabel: "Sonnet" }, startedAt: "2026-11-07T04:00:00Z", elapsedSeconds: 60,
  finishedAt: null, cost: null, stage: "doing", wait: null, needsYou: false, queueReason: null, holdUntil: null, queuePosition: null, git: null, waitingFor: [], ...extra,
});
const session = (extra: Partial<TLocalSessionSummary>): TLocalSessionSummary => ({ permissionMode: "auto",
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
/** 本机没能自动合回、等本人合（「验收后自动合并」关着）。 */
const HOLD = { reason: "auto_merge_off" as const, message: "「验收后自动合并」关着，等你合" };
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

  it("每个有 Task 的 Mission 一个同名项目（16.5），Task 都挂上；项目下是能对话的子会话（卡、专题），规划员和验收员不算；等你排在前面，第一次没过仍是进行中；不归 Task 的进「其他」；「本月」里没有 Task 的 Mission 也列", () => {
    expect(data.period).toBe("2026-11");
    expect(data.projects.map((project) => [project.projectId, project.name, project.goals.map((goal) => goal.taskId)])).toEqual([["mission:m1", "天枢 11 月", ["t1", "t2"]]]);
    expect(data.archivedCount).toBe(0);
    expect(data.month.missions.map((mission) => [mission.missionId, mission.period, mission.tasks.length])).toEqual([["m1", "2026-11", 2], ["m2", "2026-11", 0]]);
    expect(data.month.missions[0]!.tasks[0]!.project).toEqual({ projectId: "mission:m1", name: "天枢 11 月" });
    const project = data.projects[0]!;
    expect(project.subSessions.map((sub) => [sub.id, sub.state, sub.waiting, sub.queueReason])).toEqual([
      ["c1", "waiting", "approval", null], ["c4", "running", null, null], ["c2", "queued", null, "slot"], ["c3", "done", null, null],
    ]);
    expect(project.pipeline).toEqual({ conversationId: null, scope: "project:mission:m1" });
    // 本体的 Task 没有截止日：取所在月份的最后一天；没写标准时是完成定义那一条。「本月」行尾的「11/20 验收」网页按计划另算。
    expect(project.goals.map((goal) => [goal.dueDate, goal.criteriaTotal])).toEqual([["2026-11-30", 2], ["2026-11-30", 1]]);
    expect(gateLabel(plan, "m1")).toBe("11/20 验收");
    expect(gateLabel(plan, "m2")).toBeNull();
    // 「本月」那一行：挂在项目上的照项目目标的截止日（天枢里存的），没挂的退回 Mission 下一个验收时间点。
    const set = [{ goals: [{ taskId: "t9", dueDate: "2026-11-18" }] }];
    expect(taskGateLabel(set, plan, { taskId: "t9", missionId: "m1" })).toBe("11/18 验收");
    expect(taskGateLabel(set, plan, { taskId: "t8", missionId: "m1" })).toBe("11/20 验收");
    // 按 Task 存的（没挂项目也有）是唯一一份，先看它（11/19 本月页就地改）。
    const withDue = { ...plan, tasks: [{ taskId: "t8", missionId: "m1", name: "t8", doneDefinition: null, criteria: [], dueDate: "2026-11-25" }] };
    expect(taskGateLabel([], withDue, { taskId: "t8", missionId: "m1" })).toBe("11/25 验收");
    expect(project.goals[1]!.completedAt).not.toBeNull();
    expect(data.month.missions[0]!.tasks[1]!.completedAt).not.toBeNull();
    expect(data.other.subSessions).toEqual([expect.objectContaining({ id: "tp1", kind: "topic" })]);
  });

  it("首页一行现状：按紧急程度等你、进行中（没过的在自动重做）、已排队、今天完成，最多三段；交付了是已完成；规划员在拆写拆卡中；什么都没有是未开始", () => {
    const v2 = data.projects[0]!;
    expect(v2.summary).toMatchObject({ running: 1, waiting: 1, queued: 1, done: 1, doneToday: 1, needsYou: 1 });
    expect(statusLine(v2)).toBe("等你 1 · 进行中 1 · 已排队 1");
    expect(statusLine({ ...v2, completedAt: "2026-11-07T00:00:00.000Z" })).toBe("已完成");
    const idle = { ...v2, completedAt: null, subSessions: [], summary: { ...v2.summary, queued: 0, done: 0, doneToday: 0, needsYou: 0 } };
    expect(statusLine({ ...idle, planning: true })).toBe("拆卡中");
    expect(statusLine({ ...idle, planning: false })).toBe("未开始");
    // 开过子会话的不写「未开始」：之前完成的写「已完成 N」，停下了的写「已停下 N」。
    const old = v2.subSessions.find((sub) => sub.state === "done")!;
    expect(statusLine({ ...idle, subSessions: [old], summary: { ...idle.summary, done: 1 } })).toBe("已完成 1");
    expect(statusLine({ ...idle, subSessions: [{ ...old, state: "waiting", waiting: null }] })).toBe("已停下 1");
  });

  it("等你：子会话的批准、会议记录待确认；群消息只是让你知道，不进（设计 9.6）；去哪儿看由 open 映射到路由；受阻去那张卡；第一次没过自动重做，不在这里", () => {
    expect(data.waiting.map((entry) => [entry.kind, waitingHref(entry)])).toEqual([
      ["approval", "/me/work/projects/mission%3Am1"], ["meeting", "/me/work/meetings/mt1"],
    ]);
    // 能不能就地答：批准要本机办；会后确认点开去答。
    expect(data.waiting.map((entry) => entry.answer)).toEqual(["inline_local", "open"]);
    // 批准、提问由项目对话转达（14.3）：来源只写项目名，点了进项目对话（有本机会话时锚在那个框上）。
    expect(data.waiting[0]).toMatchObject({ title: "等你批准", source: "天枢 11 月", taskId: "t1", projectId: "mission:m1", open: { kind: "project", id: "mission:m1" } });
    expect(waitingHref({ open: { kind: "project", id: "p1", focus: { sessionId: "s1", requestId: null } } })).toBe("/me/work/projects/p1#ask-s1");
    const blocked = deriveWorkHome({ plan, workers: [worker({ key: "card:c9", cardId: "c9", wait: "blocked" })], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(blocked.waiting.map((entry) => [entry.kind, entry.title, waitingHref(entry)])).toEqual([["verdict", "受阻", "/me/work/cards/c9"]]);
  });

  it("验收过了、本机没能自动合回（needsMerge）：子会话是等你合回，等你里一条「合进 main」；本机还在自己合的不算等你；合回了折进已完成", () => {
    const passed = { ...worker({ key: "card:c5", cardId: "c5", title: "greet", stage: "done", finishedAt: "2026-11-07T05:00:00Z" }), workspace: { ...WORKTREE, needsMerge: HOLD } };
    const home = deriveWorkHome({ plan, workers: [passed], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(home.projects[0]!.subSessions[0]).toMatchObject({ state: "waiting", waiting: "merge", merge: { state: "needs_merge", baseBranch: "main", reason: "auto_merge_off" } });
    expect(home.waiting).toEqual([expect.objectContaining({ kind: "merge", title: "合进 main", open: { kind: "card", id: "c5" } })]);
    const merging = deriveWorkHome({ plan, workers: [{ ...passed, workspace: WORKTREE }], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(merging.projects[0]!.subSessions[0]).toMatchObject({ state: "done", waiting: null, merge: null });
    expect(merging.waiting).toEqual([]);
    const merged = deriveWorkHome({ plan, workers: [{ ...passed, workspace: { ...WORKTREE, mergedCommit: "b".repeat(40) } }], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(merged.projects[0]!.subSessions[0]).toMatchObject({ state: "done", waiting: null, merge: { state: "merged", baseBranch: "main" } });
    expect(merged.waiting).toEqual([]);
  });
});

describe("树上的卡：worker 列表只有今天完成的，看板补上之前过的；验收中的卡照样在树上", () => {
  it("昨天过了、合回了的卡折进已完成；昨天过了、这台电脑上没合回的还在等你合", () => {
    const boards = { t1: { plan: null, cards: [boardCard("c7", "昨天的", {}), boardCard("c8", "没合的", {})] } };
    const home = deriveWorkHome({ plan, workers: [], boards, proposals: [], merges: [], notices: null, deviceId: "dev-1",
      sessions: [cardSessionWith("c7", { mergedCommit: "b".repeat(40) }), cardSessionWith("c8", { needsMerge: HOLD })] });
    const subs = home.projects[0]!.subSessions;
    expect(subs.map((sub) => [sub.id, sub.state, sub.waiting])).toEqual([["c8", "waiting", "merge"], ["c7", "done", null]]);
    expect(home.waiting).toEqual([expect.objectContaining({ kind: "merge", title: "合进 main", open: { kind: "card", id: "c8" }, taskId: "t1", projectId: "mission:m1", deviceId: "dev-1" })]);
  });

  it("验收中云端只列验收员那条：卡在树上是进行中；卡本身也在列表里时不重复", () => {
    const verifying = worker({ key: "verify:c9", kind: "verify", cardId: "c9", title: "接口" });
    const only = deriveWorkHome({ plan, workers: [verifying], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(only.projects[0]!.subSessions).toEqual([expect.objectContaining({ id: "c9", kind: "card", state: "running" })]);
    const both = deriveWorkHome({ plan, workers: [verifying, worker({ key: "card:c9", cardId: "c9", title: "接口", wait: "approval" })], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(both.projects[0]!.subSessions.map((sub) => [sub.id, sub.state])).toEqual([["c9", "waiting"]]);
  });

  it("受阻（验收两次没过）进那张卡：项目下没挂 Task 的卡也有框", () => {
    expect(waitingHref({ kind: "verdict", projectId: "p1", open: { kind: "card", id: "c1" } })).toBe("/me/work/cards/c1");
    // 岗位修改建议点进去是新首页里的「岗位」二级页，不再跳出新首页。
    expect(waitingHref({ open: { kind: "role", id: "r1" } })).toBe("/me/work/settings/roles");
    expect(waitingHref({ kind: "approval", projectId: "p1", open: { kind: "card", id: "c1" } })).toBe("/me/work/cards/c1");
  });

  it("合不回、但树上没有那张卡的，照样在等你里", () => {
    const home = deriveWorkHome({ plan, workers: [], boards: {}, proposals: [], notices: null, deviceId: null,
      merges: [{ sessionId: "s-1", cardId: "c-old", title: "旧卡", text: "主文件夹有没提交的改动" }] });
    expect(home.waiting).toEqual([expect.objectContaining({ kind: "merge", title: "无法合回", open: { kind: "card", id: "c-old" } })]);
  });
});

describe("项目对话里的验收行（B 的 feed 没上时由各件 Task 看板上的卡拼）", () => {
  const base = (cardId: string, title: string, extra: Partial<TWorkerItem> = {}) => worker({ key: `card:${cardId}`, cardId, title, stage: "done", finishedAt: "2026-11-07T05:00:00Z", ...extra });

  it("过了一行从看板上的卡拼（昨天过的也在），带合回结果；受阻从还在做的卡拼；第一次没过、推翻了的不出", () => {
    const items = deriveFeed({ taskId: "t1", criteria: ["a", "b"], merges: [], sessions: [cardSessionWith("c1", { mergedCommit: "b".repeat(40) })],
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
    const items = deriveFeed({ taskId: "t1", criteria: [], merges: [], cards: [],
      workers: [withHandback(base("c2", "接口", { stage: "doing", wait: "blocked" }), { outcome: "fail", returnedAt: "2026-11-07T05:20:00Z" })] });
    expect(items).toEqual([]);
  });

  it("约定的每一条都有过了的卡（含本人「仍然通过」的），问交给认可人；只差一条不问", () => {
    const items = deriveFeed({ taskId: "t1", criteria: ["a", "b"], merges: [], workers: [], cards: [
      boardCard("c1", "一", {}, 1),
      boardCard("c2", "二", { outcome: "fail", overruled: true, finishedAt: "2026-11-07T06:00:00Z" }, 2),
    ] });
    expect(items.map((entry) => entry.kind)).toEqual(["card_passed", "card_passed", "criteria_met"]);
    expect(items[2]).toMatchObject({ taskId: "t1", met: 2, total: 2 });
    expect(deriveFeed({ taskId: "t1", criteria: ["a", "b"], merges: [], workers: [], cards: [boardCard("c1", "一", {}, 1)] }).map((entry) => entry.kind)).toEqual(["card_passed"]);
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

  it("规划、验收写「来源 · 模型 · 思考」（56、67 条）：来源总写；模型以实际为准、没报写 modelName、都没有写「自动」；思考是自动时不写；跑完的照样留着；还没拉起（没有 run）不写；子 agent、命令不写", () => {
    const run = (extra: Record<string, unknown>) => ({ mode: "auto", model: "opus", effort: "high", multiAgent: false, source: "subscription", sourceLabel: "Claude 订阅",
      origin: { provider: "claude-subscription", label: "Claude 订阅", via: null }, modelName: "Opus", actual: null, ...extra });
    const live = session({ id: "00000000-0000-4000-8000-0000000000e1", run: run({ actual: { modelName: "Opus 5.5", model: "claude-opus-5-5" } }) } as never);
    const done = session({ id: "00000000-0000-4000-8000-0000000000e2", subject: { kind: "verify", cardId: "c3" }, title: "验收：改样式", status: "done", run: run({ modelName: "Sonnet 5.5", effort: null }) } as never);
    const fresh = session({ id: "00000000-0000-4000-8000-0000000000e3", run: run({ modelName: null, effort: null, origin: undefined, sourceLabel: "我的 Claude 订阅" }) } as never);
    const queued = session({ id: "00000000-0000-4000-8000-0000000000e4", status: "queued" });
    const items = localBackground({ sessions: [live, done, fresh, queued, card], deviceId: null, canStop: true, today: "2026-11-07", taskOfCard: () => null });
    expect(items.map((entry) => [entry.kind, entry.state, entry.model ?? null])).toEqual([
      ["plan", "running", "Claude 订阅 · Opus 5.5 · 高"],
      ["verify", "done", "Claude 订阅 · Sonnet 5.5"],
      ["plan", "running", "Claude 订阅 · 自动"],
      ["plan", "queued", null],
      ["subagent", "done", null],
      ["command", "running", null],
    ]);
    expect(backgroundModel({ run: undefined, effort: "high" })).toBeNull();
    // 合并云端的同一条以这台电脑的为准，这一行跟着留下。
    expect(mergeBackground([{ ...items[0]!, model: undefined }], [items[0]!])[0]?.model).toBe("Claude 订阅 · Opus 5.5 · 高");
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
    // 项目范围：挂着的 Task 的规划员，加项目里各子会话的。
    expect(inScope(items, "project:p1", { taskIds: new Set(["t1"]), subIds: new Set() }).map((entry) => entry.title)).toEqual(["拆卡", "查资料"]);
    expect(inScope(items, "project:p1", { taskIds: new Set(), subIds: new Set(["c3"]) }).map((entry) => entry.title)).toEqual(["验收「改样式」", "验收「停掉的」"]);
    expect(inScope(items, "project:p1")).toEqual([]);
    // 拆没挂 Task 的项目的规划员：本机只知道会话（16.3），按会话 id 认。
    const projectPlanner = { ...items[0]!, id: "plan:s-project", taskId: null, sessionId: "s-project" };
    expect(inScope([projectPlanner], "project:p1", { taskIds: new Set(), subIds: new Set(), sessionIds: new Set(["s-project"]) })).toHaveLength(1);
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
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T04:12:10Z")).toBe("12 分 10 秒");
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T04:12:00Z")).toBe("12 分");
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T05:05:00Z")).toBe("1 小时 5 分");
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T05:00:30Z")).toBe("1 小时");
  });
});

describe("首页输入框的「自动」（B 的 /route 没上时，规则相同）", () => {
  const goal = (taskId: string, name: string, criteria: string[]) => ({ taskId, missionId: "m1", name, period: "2026-11", dueDate: "2026-11-30", dueDateSource: "mission" as const, criteria, criteriaMet: 0, criteriaTotal: criteria.length, completedAt: null, responsible: null });
  const projects = [
    { projectId: "p1", name: "天枢 V2", goals: [goal("t1", "11/30 上线 V2", ["本机派活跑通", "验收员逐条判"])] },
    { projectId: "p2", name: "Chat 服务", goals: [goal("t2", "11/18 上线 V1", ["约定、对表与参考评审"])] },
    { projectId: "p3", name: "A", goals: [] },
  ];
  it("只在伙伴和各项目之间选：提到项目名（两个字以上）、挂着的 Task 名或标准里四个字以上的词就发给那个项目；都没提到、或提到好几个，交给伙伴", () => {
    expect(routeText("11/18 上线 V1 那件还差什么", projects)).toEqual({ projectId: "p2" });
    expect(routeText("验收员逐条判的口径再看一下", projects)).toEqual({ projectId: "p1" });
    expect(routeText("Chat 服务今天怎么样", projects)).toEqual({ projectId: "p2" });
    expect(routeText("今天下午有什么会 A", projects)).toBe("main");
    expect(routeText("11/18 上线 V1 和 11/30 上线 V2 哪个先", projects)).toBe("main");
  });
});

describe("等你按设计 9.6（契约增补二）", () => {
  const row = (extra: Partial<WaitingItem>): WaitingItem => ({
    id: extra.id ?? "x", kind: "meeting", title: "t", source: null, open: { kind: "meeting", id: "m" }, taskId: null, projectId: null, sessionId: null, deviceId: null,
    at: null, dueAt: null, deviceName: null, letter: null, person: null, month: null, question: null, permission: null, answer: "open", ...extra,
  });

  it("顺序：卡住正在跑的活的（批准、回答、额度）在前，有截止的按截止早的在前，其余按时间新的在前", () => {
    const sorted = sortWaiting([
      row({ id: "old", at: "2026-11-01T00:00:00Z" }), row({ id: "due-late", kind: "mission_card", dueAt: "2026-11-09T00:00:00Z" }),
      row({ id: "new", at: "2026-11-06T00:00:00Z" }), row({ id: "quota", kind: "quota" }), row({ id: "due-soon", kind: "month", dueAt: "2026-11-08T00:00:00Z" }),
      row({ id: "approve", kind: "approval", answer: "inline_local" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["quota", "approve", "due-soon", "due-late", "new", "old"]);
  });

  it("新目标：别人请你认可的是只读 Task 详情，月份去月份页，电脑和额度去连接页，转交去预览", () => {
    expect(waitingHref(row({ open: { kind: "task_detail", id: "t9" } }))).toBe("/me/work/tasks/t9/info");
    expect(waitingHref(row({ open: { kind: "month", id: "2026-12" } }))).toBe("/me/work/month/2026-12");
    expect(waitingHref(row({ open: { kind: "connections", id: "this_computer" } }))).toBe("/me/work/settings/connections");
    // 月中 Task 改了（16.4）：落在项目对话里那个「停掉 / 留着」框上。
    expect(waitingHref(row({ id: "goal_changed:c1", kind: "goal_changed", open: { kind: "project", id: "p1" } }))).toBe("/me/work/projects/p1#goal-c1");
    // 别人把项目交给你（16.7）：只读预览，「接手」「不接」在那里。
    expect(waitingHref(row({ kind: "transfer", open: { kind: "transfer", id: "x1" } }))).toBe("/me/work/transfers/x1");
  });

  it("空月份（「今天」行的「11 月待敲定」）：树上没有本月的 Mission 时是本月；等你里不自己造那一行（以后云端加种类）", () => {
    expect(emptyMonth("2026-11-07", [{ period: "2026-10" }])).toBe("2026-11");
    expect(emptyMonth("2026-11-07", [])).toBe("2026-11");
    expect(emptyMonth("2026-11-07", [{ period: "2026-10" }, { period: "2026-11" }])).toBeNull();
    expect(emptyMonth(null, [])).toBeNull();
    const fallback = deriveWorkHome({ plan: { ...plan, period: "2026-10", fallbackFrom: "2026-10" } as unknown as THomePlanResponse, workers: [], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(fallback.waiting.some((item) => item.kind === "month")).toBe(false);
  });

  it("派活单拆好了还没开工：等你里一条「这样开工？」，就地答（走云端）", () => {
    const home = deriveWorkHome({ plan, workers: [], boards: { t1: { plan: null, drafts: [{}, {}] } }, proposals: [], merges: [], notices: null, deviceId: null });
    expect(home.waiting).toEqual([expect.objectContaining({ kind: "plan_start", title: "11/30 上线 V2：这样开工？", source: "2 步", answer: "inline", open: { kind: "project", id: "mission:m1" }, projectId: "mission:m1" })]);
    // 派活单选了「不要了」、几件全撤掉：等你里那一行没了。
    const dropped = deriveWorkHome({ plan, workers: [], boards: { t1: { plan: null, drafts: [] } }, proposals: [], merges: [], notices: null, deviceId: null });
    expect(dropped.waiting.some((item) => item.kind === "plan_start")).toBe(false);
  });

  it("本人自己做的执行事项在 Task 所在的项目里（9.10），退回的不列；待归位的在其他里", () => {
    const view = (id: string, extra: Record<string, unknown>) => ({ id, title: id, status: "in_progress", dueDate: null, awaitingAcceptance: false, updatedAt: "2026-11-06T00:00:00Z", planTaskId: "t1", card: null, ...extra });
    const withItems = { ...plan, activities: [{ item: view("mine", {}) }, { item: view("back", { status: "returned" }) }], unplaced: [view("loose", { planTaskId: null })] } as unknown as THomePlanResponse;
    const home = deriveWorkHome({ plan: withItems, workers: [], boards: {}, proposals: [], merges: [], notices: null, deviceId: null });
    expect(home.projects[0]!.items.map((entry) => entry.id)).toEqual(["mine"]);
    expect(home.other.items.map((entry) => entry.id)).toEqual(["loose"]);
  });

  it("等额度恢复：已排队的原因带恢复的时刻", () => {
    expect(queueText("quota", null)).toBe("等额度恢复");
    expect(queueText("quota", new Date(new Date().setHours(8, 0, 0, 0) + 86_400_000 * 0).toISOString())).toMatch(/^等额度恢复 · (\d+\/\d+ )?08:00$/);
    expect(queueText("slot", null)).toBe("等空位");
  });
});

describe("专题没有「完成」（契约修正 b5c2e100）", () => {
  it("专题的会话停下了：已暂停（等你、没有具体等什么），不是已完成", () => {
    const sub = toSubSession(worker({ key: "topic:tp1", kind: "topic", cardId: null, topicId: "tp1", title: "调研", stage: "done" }));
    expect(sub).toMatchObject({ kind: "topic", state: "waiting", waiting: null });
  });
});

describe("首页「本月」一件 Task 的子会话（主循环第 66 条）", () => {
  const sub = (id: string, extra: Partial<SubSession> = {}): SubSession => ({ id, kind: "card", letter: null, title: id, state: "running", unseen: false, waiting: null, queueReason: null,
    role: null, sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-07T00:00:00.000Z", merge: null, holdUntil: null, ...extra });
  it("这件 Task 的子会话：看板上的卡、worker 里挂着它的卡和专题；别的 Task 的不算，同一个只算一次", () => {
    const all = [sub("c1"), sub("c2"), sub("t1", { kind: "topic" }), sub("c9")];
    const workers = [{ taskId: "T", cardId: "c2", topicId: null }, { taskId: "T", cardId: null, topicId: "t1" }, { taskId: "U", cardId: "c9", topicId: null }];
    expect(monthTaskSubs("T", [...all, sub("c1")], workers, [{ id: "c1" }, { id: "c2" }]).map((entry) => entry.id)).toEqual(["c1", "c2", "t1"]);
    expect(monthTaskSubs("V", all, workers)).toEqual([]);
  });
});
