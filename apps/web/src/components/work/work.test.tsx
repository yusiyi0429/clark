import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardDraftView, THomePlanTask, TLocalCreateSessionRequest, TWorkerItem } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { groupWorkers, isWaiting, plannerWorkers, toWorker, type Worker } from "@/lib/work/workers";
import { asCreateRequest } from "@/lib/local/kinds";
import { DispatchBlock, countsText, plannerText } from "./DispatchBlock";
import { WorkerRow, secondLine } from "./WorkerRow";
import { placeBlocks } from "./WorkTimeline";
import { taskOfPath } from "./WorkHome";

const ROLE = { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" as const };
const item = (extra: Partial<TWorkerItem>): TWorkerItem => ({
  key: "card:c1", kind: "card", cardId: "c1", topicId: null, title: "同时跑的上限和排队", role: ROLE, workerNo: 1,
  task: { id: "t1", name: "本机程序第一版" }, mission: null, step: { n: 4, total: 7, label: "跑测试" },
  resource: { where: "local", deviceId: null, deviceName: "ThinkPad", modelLabel: "Sonnet" }, startedAt: "2026-11-06T04:00:00Z", elapsedSeconds: 840,
  finishedAt: null, cost: null, stage: "doing", wait: null, needsYou: false, queueReason: null, queuePosition: null, ...extra,
});
const session = (extra: Partial<TLocalSessionSummary>): TLocalSessionSummary => ({
  id: "00000000-0000-4000-8000-0000000000a1", subject: { kind: "card", cardId: "c1" }, title: "x", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅 · Sonnet",
  cwd: "C:\\w", status: "running", includePersonalConfig: false, createdAt: "2026-11-06T04:00:00Z", updatedAt: "2026-11-06T04:10:00Z", lastSeq: 3, pendingPermissions: 0,
  queuePosition: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }, ...extra,
});
const ctx = (sessions: TLocalSessionSummary[] = []) => ({ sessions, cards: new Map(), deviceName: "这台电脑" });

describe("worker 和链路", () => {
  it("云端三格照搬；带岗位没开工的是「等开工」；验收中是云端的验收员", () => {
    expect(toWorker(item({ stage: "todo", queueReason: "not_dispatched", startedAt: null, step: null }), ctx())).toMatchObject({ state: "queued", reason: "start", mark: null });
    expect(toWorker(item({ stage: "todo", queueReason: "device_offline" }), ctx())).toMatchObject({ state: "queued", reason: "offline" });
    expect(toWorker(item({ stage: "todo", queueReason: "slot", queuePosition: 3 }), ctx())).toMatchObject({ state: "queued", reason: "slot", queuePos: 3 });
    const reviewing = toWorker(item({ stage: "review", wait: "reviewing", role: { id: "00000000-0000-4000-8000-000000000009", name: "验收员", kind: "reviewer" },
      resource: { where: "cloud", deviceId: null, deviceName: null, modelLabel: "DeepSeek" } }), ctx());
    expect(reviewing).toMatchObject({ state: "doing", mark: "reviewing", where: "cloud", role: { name: "验收员", kind: "reviewer" } });
    expect(toWorker(item({ stage: "done", finishedAt: "2026-11-06T05:00:00Z" }), ctx())).toMatchObject({ state: "done", endedAt: "2026-11-06T05:00:00Z" });
  });

  it("这台电脑上的本机为准：排队写排第几，挂着权限请求是等你批准，一轮做完是等你回复；验收没过只听云端的", () => {
    expect(toWorker(item({ stage: "todo", queueReason: "not_dispatched" }), ctx([session({ status: "queued", queuePosition: 2 })]))).toMatchObject({ state: "queued", reason: "slot", queuePos: 2 });
    expect(toWorker(item({}), ctx([session({ status: "waiting_permission", pendingPermissions: 1 })]))).toMatchObject({ state: "doing", mark: "approval" });
    expect(toWorker(item({}), ctx([session({ status: "idle" })]))).toMatchObject({ mark: "reply" });
    expect(toWorker(item({ wait: "review_failed" }), ctx([session({ status: "idle" })]))).toMatchObject({ mark: "review_failed" });
    expect(isWaiting("approval") && isWaiting("blocked") && !isWaiting("reviewing") && !isWaiting("paused")).toBe(true);
  });

  it("交回后本机接的验收员：这一行换成验收员、验收中、资源是本机，回复仍对执行的会话；验收员排队时写等空位", () => {
    const exec = session({ status: "idle" });
    const verify = (status: TLocalSessionSummary["status"]) => session({ id: "00000000-0000-4000-8000-0000000000a2", subject: { kind: "verify", cardId: "c1" } as unknown as TLocalSessionSummary["subject"],
      status, modelLabel: "订阅 · Haiku", queuePosition: status === "queued" ? 1 : null });
    expect(toWorker(item({}), ctx([exec, verify("running")]))).toMatchObject({ role: { name: "验收员", kind: "reviewer" }, state: "doing", mark: "reviewing", where: "local", model: "订阅 · Haiku", session: { id: exec.id } });
    expect(toWorker(item({}), ctx([exec, verify("queued")]))).toMatchObject({ role: { name: "验收员" }, state: "queued", reason: "slot", queuePos: 1 });
    expect(toWorker(item({}), ctx([exec, verify("exited")]))).toMatchObject({ role: { name: "开发" }, mark: "reply" });
  });

  it("规划员：本机的 plan 会话是一行（同一个 Task 的登记不重复列），登记了还没开的是「拆卡 · 等开工」", () => {
    const plan = session({ id: "00000000-0000-4000-8000-0000000000a3", subject: { kind: "plan", taskId: "t1" } as unknown as TLocalSessionSummary["subject"], status: "running" });
    const splits = [{ id: "s1", taskId: "t1", createdAt: "2026-11-06T04:00:00Z" }, { id: "s2", taskId: "t2", createdAt: "2026-11-06T04:01:00Z" }];
    const tasks = [{ taskId: "t1", name: "派活单", missionId: "m1" }, { taskId: "t2", name: "本机程序", missionId: "m1" }];
    const workers = plannerWorkers({ sessions: [plan], splits, tasks, deviceName: "ThinkPad" });
    expect(workers.map((worker) => [worker.key, worker.state, worker.reason, worker.role.name, worker.where, worker.taskName])).toEqual([
      [`plan:${plan.id}`, "doing", null, "规划员", "local", "派活单"],
      ["split:s2", "queued", "start", "规划员", "local", "本机程序"],
    ]);
    expect(workers[1]).toMatchObject({ splitId: "s2", requestedAt: "2026-11-06T04:01:00Z" });
    expect(plannerText(workers[1]!, null)).toBe("拆卡 · 等开工");
    expect(plannerText(workers[0]!, { step: 2, total: 3 })).toBe("拆卡中 · 第 2/3 步");
    expect(plannerWorkers({ sessions: [{ ...plan, status: "exited" }], splits: [], tasks, deviceName: null })).toEqual([]);
  });

  it("进行中里等你的排最前；已排队按排第几", () => {
    const workers = [
      toWorker(item({ key: "a", startedAt: "2026-11-06T03:00:00Z" }), ctx()),
      toWorker(item({ key: "b", wait: "approval" }), ctx()),
      toWorker(item({ key: "q2", stage: "todo", queueReason: "slot" }), ctx()),
    ];
    const groups = groupWorkers(workers);
    expect(groups.doing.map((worker) => worker.key)).toEqual(["b", "a"]);
    expect(groups.queued.map((worker) => worker.key)).toEqual(["q2"]);
    expect(countsText(workers)).toBe("进行中 2 · 已排队 1");
  });
});

describe("worker 的一行", () => {
  /** 看得见的字。 */
  const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
  it("第一行岗位 #n、做的事、标记；第二行资源在前、Task 最后", () => {
    const worker: Worker = { ...toWorker(item({ wait: "approval" }), ctx()), ask: { text: "运行 pnpm test", command: "pnpm --filter @warmap/local test" } };
    const line = text(renderToStaticMarkup(<>{secondLine(worker, Date.parse("2026-11-06T04:14:00Z"), "本机程序第一版").map((part, i) => <span key={i}>{part}</span>)}</>));
    expect(line.indexOf("本机")).toBe(0);
    expect(line).toContain("第 4/7 步");
    expect(line).toContain("14 分");
    expect(line.endsWith("本机程序第一版")).toBe(true);
  });

  it("等你批准：派活单的行带「要运行 …」；手机和别的电脑写「到电脑上处理」", () => {
    const worker: Worker = { ...toWorker(item({ wait: "approval" }), ctx()), ask: { text: "运行测试", command: "pnpm test" } };
    const local = { runner: createMockRunner(), phase: "ready", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
      refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}><WorkerRow worker={worker} now={0} ask onChanged={vi.fn()} /></LocalContext.Provider>);
    expect(html).toContain("开发 #1");
    expect(html).toContain("等你批准");
    expect(text(html)).toContain("pnpm test");
    expect(html).toContain("到电脑上处理");
  });
});

describe("派活单", () => {
  const task: THomePlanTask = { taskId: "t1", missionId: "m1", name: "派活单与 worker 链路", doneDefinition: null, criteria: ["出派活单"], responsibleId: null };
  const draft = (id: string, title: string, extra: Partial<TCardDraftView> = {}): TCardDraftView => ({ id, planId: "00000000-0000-4000-8000-0000000000b1", position: 0, title, brief: "",
    doneDefinition: "做完", criterionIndex: 1, executor: "claude_code", modelTier: "normal", why: null, role: ROLE, suggestPresetKey: null, ...extra });
  const board = (drafts: TCardDraftView[]): TaskBoard => ({ taskId: "t1", criteria: [], cards: [], drafts, plan: null, pending: [], nextVersion: 1, fallback: false });
  const local = { runner: createMockRunner(), phase: "offline", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
    refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];

  it("拆好了：每行岗位、要干的事、对约定第几条；底下开工、改一改；没有岗位的是我自己", () => {
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
      <DispatchBlock task={task} board={board([draft("00000000-0000-4000-8000-0000000000d1", "派活单组件"), draft("00000000-0000-4000-8000-0000000000d2", "和晨星对接口", { role: null, executor: "self" })])}
        workers={[]} roles={[]} now={0} handheld={false} current={null} newest onOpenWorker={vi.fn()} onChanged={vi.fn()} />
    </LocalContext.Provider>);
    expect(html).toContain("派活单");
    expect(html).toContain("2 件 · 待开工");
    expect(html).toContain("派活单组件");
    expect(html).toContain("约定第 1 条");
    expect(html).toContain("我自己");
    expect(html).toContain("开工");
    expect(html).toContain("改一改");
  });

  it("规划员在拆：派活单页头写「拆卡 · 等开工」，不出 worker 行", () => {
    const [planner] = plannerWorkers({ sessions: [], splits: [{ id: "s1", taskId: "t1", createdAt: "2026-11-06T04:00:00Z" }], tasks: [{ taskId: "t1", name: task.name, missionId: "m1" }], deviceName: null });
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
      <DispatchBlock task={task} board={board([])} workers={[planner!]} roles={[]} now={0} handheld={false} current={null} newest onOpenWorker={vi.fn()} onChanged={vi.fn()} />
    </LocalContext.Provider>);
    expect(html).toContain('data-testid="dispatch-planning"');
    expect(html).toContain("拆卡 · 等开工");
    expect(html).not.toContain('data-testid="worker-row"');
  });

  it("开工以后默认收起，只留等你的行；页头写链路数字", () => {
    const workers = [toWorker(item({ key: "a" }), ctx()), toWorker(item({ key: "b", wait: "approval", cardId: "c2" }), ctx()), toWorker(item({ key: "c", stage: "todo", queueReason: "slot" }), ctx())];
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
      <DispatchBlock task={task} board={board([])} workers={workers} roles={[]} now={0} handheld={false} current={null} newest={false} onOpenWorker={vi.fn()} onChanged={vi.fn()} />
    </LocalContext.Provider>);
    expect(html).toContain("进行中 2 · 已排队 1");
    expect(html.match(/data-testid="worker-row"/g)).toHaveLength(1);
    expect(html).toContain("其余 2 件");
  });
});

describe("对话里插块和锚点", () => {
  it("块插在它之前最近的一条消息后面，比第一条还早的放最前", () => {
    const placed = placeBlocks(["2026-11-06T01:00:00Z", "2026-11-06T02:00:00Z"], [
      { key: "early", at: "2026-11-06T00:30:00Z", node: null },
      { key: "mid", at: "2026-11-06T01:30:00Z", node: null },
      { key: "late", at: "2026-11-06T03:00:00Z", node: null },
    ]);
    expect(placed.get(-1)?.map((block) => block.key)).toEqual(["early"]);
    expect(placed.get(0)?.map((block) => block.key)).toEqual(["mid"]);
    expect(placed.get(1)?.map((block) => block.key)).toEqual(["late"]);
  });
  it("锚到 Task 的地址", () => {
    expect(taskOfPath("/me/work/tasks/demo-task-1")).toBe("demo-task-1");
    expect(taskOfPath("/me/work")).toBeNull();
  });
});

describe("假本机程序的排队（同真程序的规矩）", () => {
  it("一批开工：满 3 个以后的排队；占位的停下，排第一的接上；一轮做完等回复的不占位", async () => {
    vi.useFakeTimers();
    const runner = createMockRunner({ stepMs: 10_000 });
    const body = (n: number): TLocalCreateSessionRequest => ({ subject: { kind: "card", cardId: `c${n}` }, title: `卡 ${n}`, cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const results = await runner.createSessionBatch([1, 2, 3, 4, 5].map(body));
    const sessions = results.map((result) => (result.ok ? result.session : null)!);
    expect(sessions.map((s) => s.status)).toEqual(["starting", "starting", "starting", "queued", "queued"]);
    expect(sessions.slice(3).map((s) => s.queuePosition)).toEqual([1, 2]);
    expect((await runner.health()).slots).toEqual({ max: 3, running: 3, queued: 2 });
    await runner.kill(sessions[0]!.id);
    const after = await runner.listSessions();
    expect(after.find((s) => s.id === sessions[3]!.id)?.status).toBe("starting");
    expect(after.find((s) => s.id === sessions[4]!.id)?.queuePosition).toBe(1);
    await runner.patchSettings({ maxConcurrent: 4 });
    expect((await runner.listSessions()).find((s) => s.id === sessions[4]!.id)?.status).toBe("starting");
    vi.useRealTimers();
  });

  it("排队先后：验收员、规划员、执行的；执行的交回以后本机自己接一个验收员，规划员拆完退出", async () => {
    vi.useFakeTimers();
    const runner = createMockRunner({ stepMs: 10, onPlanned: vi.fn() });
    await runner.patchSettings({ maxConcurrent: 1 });
    const card = (id: string): TLocalCreateSessionRequest => ({ subject: { kind: "card", cardId: id }, title: id, cwd: "C:\work\tianshu", firstMessage: "交代" });
    const [first, second, planner, verifier] = await Promise.all([
      runner.createSession(card("c1")),
      runner.createSession(card("c2")),
      runner.createSession(asCreateRequest({ subject: { kind: "plan", taskId: "t1" }, title: "拆卡", firstMessage: "拆" })),
      runner.createSession(asCreateRequest({ subject: { kind: "verify", cardId: "c0" }, title: "验收", firstMessage: "验" })),
    ]);
    const position = async (id: string) => (await runner.listSessions()).find((s) => s.id === id)?.queuePosition;
    expect(first!.status).toBe("starting");
    expect([await position(verifier!.id), await position(planner!.id), await position(second!.id)]).toEqual([1, 2, 3]);
    await runner.kill(first!.id);
    expect((await runner.listSessions()).find((s) => s.id === verifier!.id)?.status).toBe("starting");
    await vi.advanceTimersByTimeAsync(200);
    const status = async (id: string) => (await runner.listSessions()).find((s) => s.id === id)?.status;
    expect(await status(verifier!.id)).toBe("exited");
    expect(await status(planner!.id)).toBe("exited");
    // 执行的跑到权限请求：批准、回答一句，交回后接上 c2 的验收员。
    await vi.advanceTimersByTimeAsync(100);
    const pending = (await runner.getSession(second!.id)).pendingPermissions[0]!;
    await runner.decidePermission(second!.id, pending.requestId, { decision: "allow" });
    await vi.advanceTimersByTimeAsync(100);
    await runner.sendMessage(second!.id, "删掉");
    await vi.advanceTimersByTimeAsync(100);
    const chained = (await runner.listSessions()).find((s) => (s.subject as { kind: string }).kind === "verify" && s.subject.cardId === "c2");
    expect(chained).toBeDefined();
    vi.useRealTimers();
  });
});
