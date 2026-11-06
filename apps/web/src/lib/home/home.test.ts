import { describe, expect, it } from "vitest";
import type { THomePlanResponse, TWorkerItem } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { toWorker, type Worker } from "@/lib/work/workers";
import type { MemberNotification } from "@/components/member/useMemberHome";
import { backgroundItems, deriveWorkHome, duration, groupBackground, routeText, statusLine, summarize } from "./derive";

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
  missions: [{ missionId: "m1", code: "M1", title: "天枢 11 月", cardId: null, color: "#000", world: null }, { missionId: "m2", code: "M2", title: "空的", cardId: null, color: "#000", world: null }],
  tasks: [
    { taskId: "t1", missionId: "m1", name: "11/30 上线 V2", doneDefinition: "本机派活、岗位与本机验收跑通", criteria: ["本机派活跑通", "验收员逐条判"] },
    { taskId: "t2", missionId: "m1", name: "11/18 上线 V1", doneDefinition: null, criteria: ["约定、对表与参考评审"] },
  ],
} as unknown as THomePlanResponse;

describe("新首页的数据（B 的接口到之前由现有数据拼）", () => {
  const workers = [
    worker({ key: "card:c1", cardId: "c1", wait: "approval" }),
    worker({ key: "card:c2", cardId: "c2", title: "写测试", stage: "todo", queueReason: "slot" }),
    worker({ key: "card:c3", cardId: "c3", title: "改样式", stage: "done", finishedAt: "2026-11-07T05:00:00Z" }),
    worker({ key: "card:c4", cardId: "c4", title: "接口对齐", wait: "review_failed" }),
    worker({ key: "topic:tp1", kind: "topic", cardId: null, topicId: "tp1", title: "起名字", task: null }),
    worker({ key: "verify:c3", kind: "verify", cardId: "c3", title: "改样式", stage: "done", finishedAt: "2026-11-07T05:02:00Z" }),
  ];
  const data = deriveWorkHome({ plan, workers, boards: {}, proposals: [], merges: [], notices: {
    notifications: [{ id: "n1", kind: "meeting_card_pending", text: "周会记录待确认", source: "周会", objectType: "meeting", objectId: "mt1", createdAt: "2026-11-07T01:00:00Z", readAt: null } as MemberNotification],
    rounds: [], unreadThreads: [{ objectType: "issue", objectId: "i1", title: "验收口径", unread: 2, href: "/me/issues/i1" }], unreadMissionGroups: [],
  } });

  it("Task 下是能对话的子会话（卡、专题），规划员和验收员不算；等你、没过排在前面；不归 Task 的进「其他」；没有 Task 的 Mission 不列", () => {
    const blocked = deriveWorkHome({ plan, workers: [worker({ key: "card:c9", cardId: "c9", wait: "blocked" })], boards: {}, proposals: [], merges: [], notices: null });
    expect(blocked.waiting).toEqual([expect.objectContaining({ kind: "verdict", title: "受阻", href: "/me/work/tasks/t1" })]);
    expect(data.missions.map((mission) => mission.missionId)).toEqual(["m1"]);
    const v2 = data.missions[0]!.tasks[0]!;
    expect(v2.subSessions.map((sub) => [sub.id, sub.state, sub.waiting ?? null])).toEqual([
      ["c1", "waiting", "approval"], ["c4", "failed", null], ["c2", "queued", null], ["c3", "done", null],
    ]);
    expect(v2.subtitle).toBe("本机派活、岗位与本机验收跑通");
    expect(data.missions[0]!.tasks[1]!.subtitle).toBe("约定、对表与参考评审");
    expect(data.other.subSessions).toEqual([expect.objectContaining({ id: "tp1", kind: "topic" })]);
  });

  it("首页一行现状：等你、进行中（没过的在自动重做，算进行中）、已排队、已完成，没有就是还没开始；规划员在拆写拆卡中", () => {
    const v2 = data.missions[0]!.tasks[0]!;
    expect(statusLine(v2)).toBe("等你 1 · 进行中 1 · 已排队 1 · 已完成 1");
    expect(statusLine(data.missions[0]!.tasks[1]!)).toBe("还没开始");
    expect(statusLine({ summary: summarize([]), planning: true })).toBe("拆卡中");
  });

  it("等你：子会话的批准，会议记录待确认、群里的新消息，每件带去哪儿看；第一次没过自动重做，不在这里", () => {
    expect(data.waiting.map((entry) => [entry.kind, entry.href])).toEqual([
      ["approval", "/me/work/cards/c1"], ["meeting", "/me/meetings/mt1"], ["thread", "/me/issues/i1"],
    ]);
    expect(data.waiting[0]).toMatchObject({ title: "等你批准", source: "接上首页数据 · 11/30 上线 V2", ref: { workerKey: "card:c1" } });
  });
});

describe("后台任务", () => {
  const live = session({});
  const workers = [
    worker({ key: `plan:${live.id}`, kind: "plan", cardId: null, title: "11/30 上线 V2", startedAt: "2026-11-07T04:00:00Z" }, [live]),
    worker({ key: "verify:c3", kind: "verify", cardId: "c3", title: "改样式", stage: "done", finishedAt: "2026-11-07T05:02:00Z" }),
    worker({ key: "card:c1", cardId: "c1" }),
  ];

  it("规划员写「拆卡」、验收员写「验收「卡」」；卡不是后台任务；跟着展示区取范围", () => {
    const all = backgroundItems({ workers, scope: "main", canStop: true });
    expect(all.map((entry) => [entry.kind, entry.title, entry.state])).toEqual([["plan", "拆卡", "running"], ["verify", "验收「改样式」", "done"]]);
    expect(backgroundItems({ workers, scope: "task:t1", canStop: true })).toHaveLength(2);
    expect(backgroundItems({ workers, scope: "card:c3", canStop: true }).map((entry) => entry.kind)).toEqual(["verify"]);
  });

  it("这台电脑上在跑的本机会话才能停；手机上不能停", () => {
    expect(backgroundItems({ workers, scope: "main", canStop: true })[0]).toMatchObject({ stoppable: true, sessionId: live.id });
    expect(backgroundItems({ workers, scope: "main", canStop: false })[0]).toMatchObject({ stoppable: false });
  });

  it("进行中（排着的在后）和已完成两组；用时", () => {
    const groups = groupBackground([
      { id: "a", title: "a", kind: "plan", state: "queued", startedAt: null, finishedAt: null, stoppable: false },
      { id: "b", title: "b", kind: "verify", state: "running", startedAt: "2026-11-07T04:00:00Z", finishedAt: null, stoppable: false },
      { id: "c", title: "c", kind: "command", state: "failed", startedAt: "2026-11-07T04:00:00Z", finishedAt: "2026-11-07T04:00:30Z", stoppable: false },
    ]);
    expect(groups.running.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(groups.finished.map((entry) => entry.id)).toEqual(["c"]);
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T04:00:30Z")).toBe("30 秒");
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T04:12:10Z")).toBe("12 分");
    expect(duration("2026-11-07T04:00:00Z", "2026-11-07T05:05:00Z")).toBe("1 小时 5 分");
  });
});

describe("首页输入框的「自动」", () => {
  const tasks = plan.tasks;
  it("提到 Task 名或标准里四个字以上的词就发给那件 Task；都没提到、或提到好几件，交给伙伴", () => {
    expect(routeText("11/18 上线 V1 那件还差什么", tasks)).toEqual({ taskId: "t2" });
    expect(routeText("验收员逐条判的口径再看一下", tasks)).toEqual({ taskId: "t1" });
    expect(routeText("今天下午有什么会", tasks)).toBe("main");
    expect(routeText("11/18 上线 V1 和 11/30 上线 V2 哪个先", tasks)).toBe("main");
  });
});
