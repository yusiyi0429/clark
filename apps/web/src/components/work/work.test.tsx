import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardDraftView, TCardSplitRequestView, THomePlanTask, TLocalCreateSessionRequest, TWorkerItem } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { groupWorkers, isWaiting, plannerWorkers, toWorker, type Worker } from "@/lib/work/workers";
import { commitText, mergeBlockedText, mergeCard, shortPlace } from "@/lib/work/merge";
import { reply } from "@/lib/work/actions";
import { EMPTY_VIEW, foldEvents } from "@/lib/local/sessionView";
import { PlanDecision, PlanningLine, dropDrafts, plannerText } from "@/components/home/PlanDecision";
import { splitBody, WORDS_MAX } from "@/lib/board/cloud";
import { viewOf, scopeOf } from "@/components/home/view";
import { placeBlocks } from "./WorkTimeline";
import { pendingUserMessage } from "@/conversation/useConversation";
import { planAnchors } from "@/components/home/Conversations";
import { ApprovalDecision, QuestionDecision, localOptions } from "./decisions";
import { DecisionBox, otherKey } from "./DecisionBox";

const ROLE = { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" as const };
const item = (extra: Partial<TWorkerItem>): TWorkerItem => ({
  key: "card:c1", kind: "card", cardId: "c1", topicId: null, title: "同时跑的上限和排队", role: ROLE, workerNo: 1,
  task: { id: "t1", name: "本机程序第一版" }, mission: null, step: { n: 4, total: 7, label: "跑测试" },
  resource: { where: "local", deviceId: null, deviceName: "ThinkPad", modelLabel: "Sonnet" }, startedAt: "2026-11-06T04:00:00Z", elapsedSeconds: 840,
  finishedAt: null, cost: null, stage: "doing", wait: null, needsYou: false, queueReason: null, holdUntil: null, queuePosition: null, git: null, waitingFor: [], ...extra,
});
const session = (extra: Partial<TLocalSessionSummary>): TLocalSessionSummary => ({ permissionMode: "auto",
  id: "00000000-0000-4000-8000-0000000000a1", subject: { kind: "card", cardId: "c1" }, title: "x", agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅 · Sonnet",
  cwd: "C:\\w", status: "running", includePersonalConfig: false, createdAt: "2026-11-06T04:00:00Z", updatedAt: "2026-11-06T04:10:00Z", lastSeq: 3, pendingPermissions: 0,
  queuePosition: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }, ...extra,
});
const ctx = (sessions: TLocalSessionSummary[] = []) => ({ sessions, cards: new Map(), deviceName: "这台电脑" });
const split = (id: string, taskId: string): TCardSplitRequestView => ({ id, taskId, taskName: taskId === "t1" ? "派活单" : "本机程序", missionId: "m1", projectId: null, projectName: null, sourceWords: [], afterSequence: null,
  origin: "web", createdAt: taskId === "t1" ? "2026-11-06T04:00:00Z" : "2026-11-06T04:01:00Z" });

describe("worker 和链路", () => {
  it("云端三格照搬；带技能没开工的是「等开工」；验收中是云端的验收员", () => {
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
    const verify = (status: TLocalSessionSummary["status"]) => session({ id: "00000000-0000-4000-8000-0000000000a2", subject: { kind: "verify", cardId: "c1" },
      status, modelLabel: "订阅 · Haiku", queuePosition: status === "queued" ? 1 : null });
    expect(toWorker(item({}), ctx([exec, verify("running")]))).toMatchObject({ role: { name: "验收员", kind: "reviewer" }, state: "doing", mark: "reviewing", where: "local", model: "订阅 · Haiku", session: { id: exec.id } });
    expect(toWorker(item({}), ctx([exec, verify("queued")]))).toMatchObject({ role: { name: "验收员" }, state: "queued", reason: "slot", queuePos: 1 });
    expect(toWorker(item({}), ctx([exec, verify("exited")]))).toMatchObject({ role: { name: "开发" }, mark: "reply" });
  });

  it("规划员：云端还没列上的本机 plan 会话补一行，登记了还没开的是「拆卡 · 等开工」（已有规划员的 Task 不重复列）", () => {
    const plan = session({ id: "00000000-0000-4000-8000-0000000000a3", subject: { kind: "plan", taskId: "t1" }, status: "running" });
    const tasks = [{ taskId: "t1", name: "派活单", missionId: "m1" }, { taskId: "t2", name: "本机程序", missionId: "m1" }];
    const workers = plannerWorkers({ sessions: [plan], splits: [split("s1", "t1"), split("s2", "t2")], listed: [], tasks, deviceName: "ThinkPad" });
    expect(workers.map((worker) => [worker.key, worker.state, worker.reason, worker.role.name, worker.where, worker.taskName])).toEqual([
      [`plan:${plan.id}`, "doing", null, "规划员", "local", "派活单"],
      ["split:s2", "queued", "start", "规划员", "local", "本机程序"],
    ]);
    expect(workers[1]).toMatchObject({ splitId: "s2", requestedAt: "2026-11-06T04:01:00Z" });
    expect(plannerText(workers[1]!, null)).toBe("拆卡 · 等开工");
    expect(plannerText(workers[0]!, { step: 2, total: 3 })).toBe("拆卡中 · 第 2/3 步");
    expect(plannerWorkers({ sessions: [{ ...plan, status: "exited" }], splits: [], listed: [], tasks, deviceName: null })).toEqual([]);
  });

  it("没挂 Task 的项目也能拆（16.3）：本机会话只带 projectId、登记只带项目，都是这个项目的规划员；同一个项目在拆时登记不重复列", () => {
    const P = "00000000-0000-4000-8000-0000000000f1";
    const plan = session({ id: "00000000-0000-4000-8000-0000000000a4", subject: { kind: "plan", projectId: P }, status: "running" });
    const projectSplit = (id: string, projectId: string): TCardSplitRequestView => ({ id, taskId: null, taskName: null, missionId: null, projectId, projectName: "本机程序", sourceWords: [], afterSequence: null,
      origin: "buddy", createdAt: "2026-11-06T04:02:00Z" });
    const workers = plannerWorkers({ sessions: [plan], splits: [projectSplit("s3", P), projectSplit("s4", "00000000-0000-4000-8000-0000000000f2")], listed: [], tasks: [], deviceName: null });
    expect(workers.map((worker) => [worker.key, worker.taskId, worker.projectId, worker.state])).toEqual([
      [`plan:${plan.id}`, null, P, "doing"], ["split:s4", null, "00000000-0000-4000-8000-0000000000f2", "queued"],
    ]);
    expect(workers[1]!.title).toBe("本机程序");
  });

  it("云端的规划员、验收员行：这台电脑上有本机会话时以本机为准、不重复列；手机上照云端（验收员在跑是验收中，没起是等开工）", () => {
    const plan = session({ id: "00000000-0000-4000-8000-0000000000a3", subject: { kind: "plan", taskId: "t1" }, status: "queued", queuePosition: 2 });
    const cloudPlan = item({ key: `plan:${plan.id}`, kind: "plan", cardId: null, title: "派活单", role: { id: "00000000-0000-4000-8000-0000000000e1", name: "规划员", kind: "worker" },
      task: { id: "t1", name: "派活单" }, stage: "doing" });
    const merged = toWorker(cloudPlan, ctx([plan]));
    expect(merged).toMatchObject({ kind: "plan", state: "queued", reason: "slot", queuePos: 2, session: { id: plan.id } });
    expect(plannerWorkers({ sessions: [plan], splits: [split("s1", "t1")], listed: [merged], tasks: [], deviceName: null })).toEqual([]);
    const reviewer = { id: "00000000-0000-4000-8000-0000000000e2", name: "验收员", kind: "reviewer" as const };
    const cloudVerify = (extra: Partial<TWorkerItem>) => item({ key: "verify:c1", kind: "verify", role: reviewer, stage: "review", ...extra });
    expect(toWorker(cloudVerify({}), ctx())).toMatchObject({ state: "doing", mark: "reviewing" });
    expect(toWorker(cloudVerify({ queueReason: "not_dispatched", startedAt: null }), ctx())).toMatchObject({ state: "queued", reason: "start" });
    expect(toWorker(cloudVerify({ queueReason: "device_offline" }), ctx())).toMatchObject({ state: "queued", reason: "offline" });
    const verify = session({ id: "00000000-0000-4000-8000-0000000000a2", subject: { kind: "verify", cardId: "c1" }, status: "running", modelLabel: "订阅 · Haiku" });
    expect(toWorker(cloudVerify({ queueReason: "not_dispatched" }), ctx([verify]))).toMatchObject({ state: "doing", mark: "reviewing", model: "订阅 · Haiku", session: { id: verify.id } });
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
  });
});

describe("选项框", () => {
  /** 看得见的字。 */
  const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
  const local = { runner: createMockRunner(), phase: "ready", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
    refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
  const permission = (requestId: string, extra: Record<string, unknown> = {}) => ({ requestId, toolName: "Bash", title: "运行 pnpm test", input: { command: "pnpm --filter @warmap/web test" },
    outsidePaths: [], canAllowForSession: true, ...extra }) as never;

  it("批准：批准（推荐）/ 同类以后都批准（写清范围，回车不会选它）/ 换个做法，带命令；几件一起来时 1/2 和全部批准；工作区外只剩批准、换个做法，路径标出、加 chip；对外的加 chip", () => {
    const oneHtml = renderToStaticMarkup(<ApprovalDecision requests={[permission("p1")]} onDecide={vi.fn()} />);
    const one = text(oneHtml);
    expect(one).toContain("pnpm --filter @warmap/web test");
    expect(one).toContain("批准（推荐）");
    expect(one.indexOf("同类以后都批准")).toBeGreaterThan(one.indexOf("批准（推荐）"));
    expect(one).toContain("这个子会话内");
    expect(oneHtml.indexOf('placeholder="换个做法…"')).toBeGreaterThan(oneHtml.indexOf("同类以后都批准"));
    expect(one).not.toContain("全部批准");
    expect(one).not.toContain("对外");
    const two = text(renderToStaticMarkup(<ApprovalDecision requests={[permission("p1"), permission("p2")]} onDecide={vi.fn()} />));
    expect(two).toContain("1/2");
    expect(two).toContain("全部批准");
    const outside = text(renderToStaticMarkup(<ApprovalDecision requests={[permission("p3", { outsidePaths: ["D:/secrets"] })]} onDecide={vi.fn()} />));
    expect(outside).toContain("工作区外");
    expect(outside).toContain("D:/secrets");
    expect(outside).not.toContain("同类以后都批准");
    expect(outside).not.toContain("允许这一次");
    const push = text(renderToStaticMarkup(<ApprovalDecision requests={[permission("p4", { input: { command: "git push origin main" } })]} onDecide={vi.fn()} />));
    expect(push).toContain("对外");
  });

  it("批准说人话（主循环第 64 条）：第一行是 description，第二行「会动：文件名」，命令收进「命令」默认不展开；工作树里的会话默认展开；没有 description 照原样", () => {
    const said = { description: "查 3 个候选名在商标网上有没有近似", paths: ["notes/trademark.md", "C:/work/brand/names.csv", "a.txt", "b.txt"] };
    const html = renderToStaticMarkup(<ApprovalDecision requests={[permission("p5", said)]} onDecide={vi.fn()} />);
    const page = text(html);
    expect(page.trim().startsWith("查 3 个候选名在商标网上有没有近似")).toBe(true);
    expect(page).toContain("会动：trademark.md、names.csv、a.txt 等 4 个");
    expect(page).toContain("命令");
    expect(page).not.toContain("pnpm --filter @warmap/web test");
    expect(page).not.toContain("运行 pnpm test");
    expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="approval-command"/);
    const tree = text(renderToStaticMarkup(<ApprovalDecision requests={[permission("p5", said)]} inWorktree onDecide={vi.fn()} />));
    expect(tree).toContain("pnpm --filter @warmap/web test");
    const plain = text(renderToStaticMarkup(<ApprovalDecision requests={[permission("p6")]} onDecide={vi.fn()} />));
    expect(plain).toContain("运行 pnpm test");
    expect(plain).not.toContain("会动");
    expect(plain).toContain("pnpm --filter @warmap/web test");
  });

  it("手机和别的电脑上只显示要做的事，不给选项，写到电脑上处理", () => {
    const html = renderToStaticMarkup(<ApprovalDecision requests={[permission("p1")]} blocked="到电脑上处理" onDecide={vi.fn()} />);
    expect(html).toContain("到电脑上处理");
    expect(html).toContain("pnpm --filter @warmap/web test");
    expect(html).not.toContain("decision-option");
  });

  it("提问：Claude Code 标的推荐挪到第一个、去掉括号；最后一项自己说…；数字键标在每个选项上", () => {
    expect(localOptions([{ label: "留着", description: "" }, { label: "删掉 (Recommended)", description: "只留新的" }])).toEqual({
      options: [{ label: "删掉", detail: "只留新的", recommended: true }, { label: "留着", detail: null, recommended: false }], order: [1, 0] });
    const request = { requestId: "q-1", askedAt: "2026-11-07T01:00:00Z", questions: [{ header: "安装说明", question: "旧的安装说明要不要一起删掉？", multiSelect: false,
      options: [{ label: "留着", description: "放进附录" }, { label: "删掉（推荐）", description: "只留新的" }] }] };
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}><QuestionDecision request={request} onAnswer={vi.fn()} /></LocalContext.Provider>);
    const visible = text(html);
    expect(visible).toContain("旧的安装说明要不要一起删掉？");
    expect(visible.indexOf("删掉")).toBeLessThan(visible.indexOf("留着"));
    expect(visible).toContain("推荐");
    expect(html).toMatch(/<textarea[^>]*placeholder="自己说…"/);
    expect(html.match(/aria-keyshortcuts="\d"/g)).toEqual(['aria-keyshortcuts="1"', 'aria-keyshortcuts="2"', 'aria-keyshortcuts="3"']);
  });
});

describe("选项框的「自己说」就是最后一行的输入框", () => {
  const box = () => renderToStaticMarkup(<DecisionBox kind="question" title="用哪个库？" onPick={vi.fn()} other={{ onSubmit: vi.fn() }}
    options={[{ label: "A", recommended: true }, { label: "B" }, { label: "C" }]} />);

  it("输入框就在第 4 行：同样的序号 4，占位「自己说…」，数字 4 指向它；下面不再有第二个框", () => {
    const html = box();
    const row = html.match(/<div[^>]*data-testid="decision-other"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    expect(row).toMatch(/<kbd[^>]*>4<\/kbd><textarea[^>]*>/);
    expect(row).toMatch(/<textarea[^>]*aria-label="自己说"[^>]*placeholder="自己说…"|<textarea[^>]*placeholder="自己说…"[^>]*aria-label="自己说"/);
    expect(row).toContain('aria-keyshortcuts="4"');
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toContain("aria-expanded");
    // 没字时行尾没有发送箭头。
    expect(row).not.toContain('aria-label="发送"');
  });

  it("回车发出，Shift+回车换行；Esc 或光标在最前面按 ↑ 回到上一行", () => {
    const at = (start: number, end = start) => ({ selectionStart: start, selectionEnd: end });
    expect(otherKey({ key: "Enter", shiftKey: false }, at(3))).toBe("send");
    expect(otherKey({ key: "Enter", shiftKey: true }, at(3))).toBeNull();
    expect(otherKey({ key: "Escape", shiftKey: false }, at(3))).toBe("up");
    expect(otherKey({ key: "ArrowUp", shiftKey: false }, at(0))).toBe("up");
    expect(otherKey({ key: "ArrowUp", shiftKey: false }, at(5))).toBeNull();
    expect(otherKey({ key: "4", shiftKey: false }, at(0))).toBeNull();
  });
});

describe("开工（Task 管线里的选项框）", () => {
  const task: THomePlanTask = { taskId: "t1", missionId: "m1", name: "派活单与 worker 链路", doneDefinition: null, criteria: ["出派活单"], responsibleId: null };
  const draft = (id: string, title: string, extra: Partial<TCardDraftView> = {}): TCardDraftView => ({ id, planId: "00000000-0000-4000-8000-0000000000b1", position: 0, title, brief: "",
    doneDefinition: "做完", criterionIndex: 1, executor: "claude_code", modelTier: "normal", why: null, role: ROLE, suggestPresetKey: null, sourceWords: [], ...extra });
  const local = { runner: createMockRunner(), phase: "offline", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
    refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];

  it("拆好了：问「Task 名：这样开工？」，编号的几步，每步的技能、对约定第几条，几个子会话；就按这个开始（推荐）/ 改一改 / 自己说；没有技能的是我自己", () => {
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
      <PlanDecision target={{ taskId: task.taskId }} name={task.name} drafts={[draft("00000000-0000-4000-8000-0000000000d1", "派活单组件"), draft("00000000-0000-4000-8000-0000000000d2", "和晨星对接口", { role: null, executor: "self" })]}
        roles={[]} handheld={false} onSay={vi.fn()} onChanged={vi.fn()} />
    </LocalContext.Provider>);
    expect(html).toContain("派活单与 worker 链路：这样开工？");
    expect(html).toContain("1 个子会话");
    expect(html).toContain("派活单组件");
    expect(html).toContain("约定第 1 条");
    expect(html).toContain("我自己");
    expect(html).toContain("就按这个开始");
    expect(html).toContain("推荐");
    expect(html).toContain("改一改");
    expect(html).toContain("自己说…");
    expect(html).not.toContain(">开工<");
    expect(html).toContain('data-testid="plan-mode"');
  });

  it("「不要了」排在改一改后面、自己说前面，手机上也有；没有推荐标", () => {
    for (const handheld of [false, true]) {
      const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
        <PlanDecision target={{ taskId: task.taskId }} name={task.name} drafts={[draft("00000000-0000-4000-8000-0000000000d1", "派活单组件")]}
          roles={[]} handheld={handheld} onSay={vi.fn()} onChanged={vi.fn()} />
      </LocalContext.Provider>);
      const at = ["就按这个开始", "改一改", "不要了", "自己说…"].map((label) => html.indexOf(label));
      expect(at.every((index, i) => index > (at[i - 1] ?? -1))).toBe(true);
      expect(html.match(/推荐/g)).toHaveLength(1);
    }
  });

  it("点了「不要了」：每件都撤掉；没撤完重试时跳过撤过的", async () => {
    const ids = ["d1", "d2", "d3"].map((id) => ({ id }));
    const dismiss = vi.fn(async (id: string) => { if (id === "d2" && dismiss.mock.calls.length === 2) throw new Error("断网"); });
    const done = new Set<string>();
    await expect(dropDrafts(ids, done, dismiss)).rejects.toThrow("断网");
    await dropDrafts(ids, done, dismiss);
    expect(dismiss.mock.calls.map(([id]) => id)).toEqual(["d1", "d2", "d2", "d3"]);
  });

  it("没挂 Task 的项目的派活单：框顶写项目名；没有预算那一栏（开工用本人的缺省预算）", () => {
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
      <PlanDecision target={{ projectId: "00000000-0000-4000-8000-0000000000f1" }} name="本机程序" drafts={[draft("00000000-0000-4000-8000-0000000000d3", "接上 clone", { criterionIndex: null })]}
        roles={[]} handheld={false} onSay={vi.fn()} onChanged={vi.fn()} />
    </LocalContext.Provider>);
    expect(html).toContain("本机程序：这样开工？");
    expect(html).toContain("接上 clone");
    expect(html).not.toContain('data-testid="plan-mode"');
    expect(html).not.toContain("约定第");
  });

  it("网页登记拆卡带上输入框里的话（16.8）：去掉首尾空白、最多 4000 字；没写就不带请求体", () => {
    expect(splitBody(`  ${"字".repeat(WORDS_MAX + 100)}  `)).toEqual({ words: "字".repeat(WORDS_MAX) });
    expect(splitBody("先拆登录 ")).toEqual({ words: "先拆登录" });
    expect(splitBody("   ")).toBeUndefined();
    expect(splitBody()).toBeUndefined();
  });

  it("派活单每一步带本人原话（16.8）：引用样式放在这一步下面，原文照登；没有原话的那步不画", () => {
    const words = { sourceWords: ["先把 clone 接上，别动登录"] };
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}>
      <PlanDecision target={{ projectId: "00000000-0000-4000-8000-0000000000f1" }} name="本机程序"
        drafts={[draft("00000000-0000-4000-8000-0000000000d3", "接上 clone", words), draft("00000000-0000-4000-8000-0000000000d4", "补测试")]}
        roles={[]} handheld={false} onSay={vi.fn()} onChanged={vi.fn()} />
    </LocalContext.Provider>);
    expect(html.match(/data-testid="source-words"/g)).toHaveLength(1);
    expect(html).toMatch(/接上 clone.*<blockquote[^>]*data-testid="source-words"><p>先把 clone 接上，别动登录<\/p><\/blockquote>.*补测试/);
  });

  it("规划员在拆：一行「拆卡 · 等开工」；本机在拆写第几步", () => {
    const [planner] = plannerWorkers({ sessions: [], splits: [split("s1", "t1")], listed: [], tasks: [], deviceName: null });
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}><PlanningLine planner={planner!} /></LocalContext.Provider>);
    expect(html).toContain('data-testid="planning-line"');
    expect(html).toContain("拆卡 · 等开工");
    expect(plannerText({ ...planner!, state: "doing" }, { step: 2, total: 3 })).toBe("拆卡中 · 第 2/3 步");
  });
});

describe("对话里插块和锚点", () => {
  it.each([
    [{ sequence: 1 }],
    [{ sequence: 1, createdAt: "2026-11-15T03:00:00Z" }, { sequence: 2, createdAt: "2026-11-15T06:00:00Z" }],
  ])("不同偏移的会议和来件按实际时刻排列，即使落在同一个消息间隙", (...messages) => {
    const blocks = [
      { key: "later-utc", at: "2026-11-15T05:00:00Z", node: null },
      { key: "earlier-local", at: "2026-11-15T12:00:00+08:00", node: null },
      { key: "same-instant", at: "2026-11-15T04:00:00Z", node: null },
    ];
    const placed = placeBlocks(messages, blocks);
    expect(placed.get(0)?.map(block => block.key)).toEqual(["earlier-local", "same-instant", "later-utc"]);
  });

  it("块插在它之前最近的一条消息后面，比第一条还早的放最前", () => {
    const placed = placeBlocks([{ sequence: 1, createdAt: "2026-11-06T01:00:00Z" }, { sequence: 2, createdAt: "2026-11-06T02:00:00Z" }], [
      { key: "early", at: "2026-11-06T00:30:00Z", node: null },
      { key: "mid", at: "2026-11-06T01:30:00Z", node: null },
      { key: "late", at: "2026-11-06T03:00:00Z", node: null },
    ]);
    expect(placed.get(-1)?.map((block) => block.key)).toEqual(["early"]);
    expect(placed.get(0)?.map((block) => block.key)).toEqual(["mid"]);
    expect(placed.get(1)?.map((block) => block.key)).toEqual(["late"]);
  });
  it("带 runId 的块（Miles 替你问）挂在这一轮最后一句提问后面、回答前面；不带 runId 或这一轮对不上的照旧按时间", () => {
    const t0 = Date.parse("2026-11-21T02:00:00Z");
    const chat = [
      { sequence: 1, role: "user", runId: "R", createdAt: new Date(t0).toISOString() },
      { sequence: 2, role: "assistant", runId: "R", createdAt: new Date(t0 + 1).toISOString() },
    ];
    const asked = (runId?: string) => placeBlocks(chat, [{ key: "asked", at: new Date(t0 + 10_000).toISOString(), node: null, ...(runId ? { runId } : {}) }]);
    expect(asked("R").get(0)?.map((block) => block.key)).toEqual(["asked"]);
    expect(asked("R").has(1)).toBe(false);
    expect(asked().get(1)?.map((block) => block.key)).toEqual(["asked"]);
    expect(asked("other").get(1)?.map((block) => block.key)).toEqual(["asked"]);
  });
  it("按序号排的块（转交卡）：Chat 读回来的消息不带时间，插在序号不超过 afterSequence 的最后一条后面；null 排最后；对话还没读回来时在最前", () => {
    const chat = [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }];
    const transfer = (afterSequence: number | null) => [{ key: "transfer", at: "2020-01-01T00:00:00Z", node: null, afterSequence }];
    expect(placeBlocks(chat, transfer(2)).get(1)?.map((block) => block.key)).toEqual(["transfer"]);
    expect(placeBlocks(chat, transfer(3)).get(2)?.map((block) => block.key)).toEqual(["transfer"]);
    expect(placeBlocks(chat, transfer(null)).get(2)?.map((block) => block.key)).toEqual(["transfer"]);
    expect(placeBlocks([], transfer(2)).get(-1)?.map((block) => block.key)).toEqual(["transfer"]);
  });
  it("29 条 C：对话里有消息不带时间（Chat 读回来的历史），按时间排的块全放在最后一条后面，块之间仍按时间先后，不再落到最前面", () => {
    const blocks = [
      { key: "approve", at: "2026-11-09T02:00:00Z", node: null },
      { key: "planning", at: "2026-11-09T01:00:00Z", node: null },
    ];
    expect(placeBlocks([{ sequence: 1 }, { sequence: 2 }], blocks).get(1)?.map((block) => block.key)).toEqual(["planning", "approve"]);
    expect(placeBlocks([{ sequence: 1 }, { sequence: 2 }], blocks).has(-1)).toBe(false);
    // 只有一条没带时间（比如刚发出去的）也一样。
    expect(placeBlocks([{ sequence: 1, createdAt: "2026-11-09T00:00:00Z" }, { sequence: 2 }], blocks).get(1)?.map((block) => block.key)).toEqual(["planning", "approve"]);
  });
  it("29 条 C：全部带时间照旧按时间插；有序号的块不受没时间的消息影响", () => {
    const timed = placeBlocks([{ sequence: 1, createdAt: "2026-11-09T01:00:00Z" }, { sequence: 2, createdAt: "2026-11-09T03:00:00Z" }],
      [{ key: "mid", at: "2026-11-09T02:00:00Z", node: null }]);
    expect(timed.get(0)?.map((block) => block.key)).toEqual(["mid"]);
    const mixed = placeBlocks([{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }], [
      { key: "transfer", at: "2020-01-01T00:00:00Z", node: null, afterSequence: 1 },
      { key: "planning", at: "2026-11-09T01:00:00Z", node: null },
    ]);
    expect(mixed.get(0)?.map((block) => block.key)).toEqual(["transfer"]);
    expect(mixed.get(2)?.map((block) => block.key)).toEqual(["planning"]);
  });
  it("发话时先放进去的本人消息带时间，按时间插的块不挪到最后", () => {
    const history = [
      { sequence: 1, role: "user" as const, content: "早", createdAt: "2020-01-01T01:00:00Z" },
      { sequence: 2, role: "assistant" as const, content: "好", createdAt: "2020-01-01T03:00:00Z" },
    ];
    const blocks = [
      { key: "accepted", at: "2020-01-01T02:00:00Z", node: null },
      { key: "meeting", at: "2020-01-01T04:00:00Z", node: null },
    ];
    const where = (messages: { createdAt?: string; sequence: number }[]) =>
      Object.fromEntries([...placeBlocks(messages, blocks)].flatMap(([index, placed]) => placed.map((block) => [block.key, index])));
    const sent = [...history, pendingUserMessage(3, "新的一句", [], [])];
    expect(where(sent)).toEqual(where(history));
    expect(where(sent)).toEqual({ accepted: 0, meeting: 1 });
  });
  it("29 条 B：拆卡那几块按序号插——在拆、派活单插在开拆那一下的后面，开了哪几个子会话插在开工那一下的后面；为 null 放最后", () => {
    const chat = [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }, { sequence: 4 }];
    const keysAt = (anchors: ReturnType<typeof planAnchors>) => {
      const placed = placeBlocks(chat, [
        { key: "planning", at: "2026-11-09T01:00:00Z", node: null, afterSequence: anchors.planning },
        { key: "drafts", at: "2026-11-09T01:01:00Z", node: null, afterSequence: anchors.drafts },
        { key: "started", at: "2026-11-09T01:02:00Z", node: null, afterSequence: anchors.started },
      ]);
      return Object.fromEntries([...placed].flatMap(([index, blocks]) => blocks.map((block) => [block.key, index])));
    };
    // 登记了还没开：用登记时记的（第 2 条）。
    expect(keysAt(planAnchors({ afterSequence: 2 }, null))).toMatchObject({ planning: 1, drafts: 3, started: 3 });
    // 开起来以后：用这次计划记的；拆完开了工：派活单在第 2 条后、开了哪几个在第 3 条后。
    expect(keysAt(planAnchors(undefined, { status: "running", afterSequence: 2, startedAfterSequence: null })).planning).toBe(1);
    expect(keysAt(planAnchors(undefined, { status: "done", afterSequence: 2, startedAfterSequence: 3 }))).toMatchObject({ planning: 3, drafts: 1, started: 2 });
    // 老记录、读不到：都放最后。
    expect(keysAt(planAnchors({ afterSequence: null }, { status: "done", afterSequence: null, startedAfterSequence: null }))).toEqual({ planning: 3, drafts: 3, started: 3 });
  });
  it("29 条 B：项目对话里开拆、开工带上本人看到的最后一条；不带时请求体里没有这个字段", () => {
    expect(splitBody(undefined, 7)).toEqual({ afterSequence: 7 });
    expect(splitBody("先拆登录", 7)).toEqual({ words: "先拆登录", afterSequence: 7 });
    expect(splitBody(undefined, undefined)).toBeUndefined();
  });
  it("展示区按地址：首页、总管线、Task 管线、Task 详情、子会话；右栏跟着它取范围", () => {
    expect(viewOf("/me/work")).toEqual({ kind: "home" });
    expect(viewOf("/me/work/")).toEqual({ kind: "home" });
    expect(viewOf("/me/work/buddy")).toEqual({ kind: "buddy" });
    expect(viewOf("/me/work/tasks/demo-task-1")).toEqual({ kind: "task", taskId: "demo-task-1" });
    expect(viewOf("/me/work/tasks/demo%20task/info")).toEqual({ kind: "info", taskId: "demo task" });
    expect(viewOf("/me/work/cards/c1")).toEqual({ kind: "card", id: "c1" });
    expect(viewOf("/me/work/topics/tp1")).toEqual({ kind: "topic", id: "tp1" });
    // 二级页、月份页（月份是 YYYY-MM，不是的落回首页）；右栏只要资源块。
    expect(viewOf("/me/work/settings/connections")).toEqual({ kind: "page", page: "connections" });
    expect(viewOf("/me/work/month/2026-11")).toEqual({ kind: "month", period: "2026-11" });
    expect(viewOf("/me/work/month/11")).toEqual({ kind: "home" });
    expect([viewOf("/me/work/settings/connections"), viewOf("/me/work/month/2026-11")].map(scopeOf)).toEqual(["resources", "resources"]);
    expect([viewOf("/me/work"), viewOf("/me/work/buddy"), viewOf("/me/work/tasks/t1/info"), viewOf("/me/work/cards/c1")].map(scopeOf)).toEqual(["main", "main", "task:t1", "card:c1"]);
  });
});

describe("卡在哪做和合并（ADR 0038）", () => {
  const worktree = { kind: "worktree" as const, folder: "C:\\work\\tianshu", path: "C:\\data\\worktrees\\c1", branch: "tianshu/c1-board", baseBranch: "main",
    baseCommit: "a".repeat(40), mergedCommit: null };
  it("行里写分支，不是 git 仓库的写文件夹名；同一个文件夹另一张在做时排着写等文件夹空出来", () => {
    expect(toWorker(item({}), ctx([session({ workspace: worktree })])).workspace).toMatchObject({ branch: "tianshu/c1-board" });
    expect(shortPlace({ kind: "folder", folder: "C:\\work\\notes" })).toBe("notes");
    const folder = { kind: "folder" as const, folder: "C:\\work\\notes" };
    const other = session({ id: "00000000-0000-4000-8000-0000000000a9", subject: { kind: "card", cardId: "c9" }, status: "running", workspace: folder });
    const waiting = toWorker(item({}), ctx([session({ status: "queued", queuePosition: 1, workspace: folder }), other]));
    expect(waiting).toMatchObject({ state: "queued", reason: "folder" });
    expect(shortPlace(waiting.workspace!)).toBe("notes");
  });

  it("手机和别的电脑上：分支和提交用云端记的，验收过的写验过的提交", () => {
    const git = { branch: "tianshu/c1-board", baseBranch: "main", baseCommit: "a".repeat(40), commit: "b".repeat(40), verifiedCommit: "b".repeat(40) };
    const worker = toWorker(item({ stage: "done", finishedAt: "2026-11-06T05:00:00Z", git }), ctx());
    expect(worker.git).toEqual(git);
    expect(commitText(git)).toBe("交回 bbbbbbb · 验过 bbbbbbb");
    expect(commitText({ ...git, verifiedCommit: null })).toBe("交回 bbbbbbb");
  });

  it("合不了的原因说人话：主文件夹不在基线分支、有没提交的改动、有冲突（列文件）", () => {
    expect(mergeBlockedText({ merged: false, reason: "base_not_checked_out", message: "", files: [] }, "main")).toBe("主文件夹现在不在 main 分支上，切回去再合并");
    expect(mergeBlockedText({ merged: false, reason: "dirty", message: "", files: ["a.ts", "b.ts"] }, "main")).toBe("主文件夹有没提交的改动：a.ts、b.ts");
    expect(mergeBlockedText({ merged: false, reason: "conflict", message: "", files: ["1", "2", "3", "4", "5", "6"] }, "main")).toBe("有冲突：1、2、3、4、5 等 6 个。这次合并已放弃，主文件夹没动");
  });

  it("假本机程序：仓库文件夹里的卡在自己的分支上做；合并第一次回主文件夹不干净，再点合上，合过再点是 409 的原话", async () => {
    vi.useFakeTimers();
    const runner = createMockRunner({ stepMs: 10_000 });
    const created = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "Board rows", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    expect(created.workspace).toMatchObject({ kind: "worktree", branch: "tianshu/c1-board-rows", baseBranch: "main", mergedCommit: null });
    expect((await mergeCard(runner, created, "Board rows"))).toEqual({ ok: false, text: "卡或它的验收员还在跑，停下再合" });
    const stopped = await runner.kill(created.id);
    expect(await mergeCard(runner, stopped, "Board rows")).toMatchObject({ ok: false, text: "主文件夹有没提交的改动：README.md、apps/web/src/app/page.tsx" });
    const merged = await mergeCard(runner, stopped, "Board rows");
    expect(merged.ok).toBe(true);
    expect((await runner.getSession(created.id)).session.workspace).toMatchObject({ mergedCommit: merged.ok ? merged.commit : "" });
    expect(await mergeCard(runner, stopped, "Board rows")).toEqual({ ok: false, text: "这张卡已经合回过了" });
    const plain = await runner.createSession({ subject: { kind: "card", cardId: "c2" }, title: "笔记", cwd: "C:\\work\\project-2", firstMessage: "交代" });
    const second = await runner.createSession({ subject: { kind: "card", cardId: "c3" }, title: "笔记二", cwd: "C:\\work\\project-2", firstMessage: "交代" });
    expect(plain.workspace).toEqual({ kind: "folder", folder: "C:\\work\\project-2" });
    expect(second.status).toBe("queued");
    vi.useRealTimers();
  });
});

describe("执行方问本人、卡等前面的卡", () => {
  const request = { requestId: "q-1", askedAt: "2026-11-07T01:00:00Z", questions: [{ header: "安装说明", question: "旧的安装说明要不要一起删掉？", multiSelect: false,
    options: [{ label: "删掉", description: "只留新的" }, { label: "留着", description: "放进附录" }] }] };
  const local = { runner: createMockRunner(), phase: "ready", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
    refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];

  it("问着的时候是等你回复，对话里是选项框写问的是什么、选项能点；答了就收起", () => {
    const worker = toWorker(item({}), ctx([session({ status: "idle", pendingQuestion: request })]));
    expect(worker.mark).toBe("reply");
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}><QuestionDecision request={worker.session!.pendingQuestion!} onAnswer={vi.fn()} /></LocalContext.Provider>);
    expect(html).toContain('data-testid="question-decision"');
    expect(html).toContain("旧的安装说明要不要一起删掉？");
    expect(html).toContain("删掉");
    expect(html).toContain("留着");
    const view = foldEvents([
      { seq: 1, at: "2026-11-07T01:00:00Z", sessionId: "s", type: "question", request },
      { seq: 2, at: "2026-11-07T01:01:00Z", sessionId: "s", type: "question_resolved", requestId: "q-1", choices: [["删掉"]], text: null },
    ] as never, EMPTY_VIEW);
    expect(view.question).toBeNull();
    expect(view.entries.map((entry) => entry.kind === "notice" ? entry.text : "")).toEqual(["问：旧的安装说明要不要一起删掉？", "答：删掉"]);
  });

  it("在问的时候写一句就是回答这次提问（不选选项）", async () => {
    const runner = { answerQuestion: vi.fn(async () => undefined), sendMessage: vi.fn() };
    await reply(runner as never, toWorker(item({}), ctx([session({ status: "idle", pendingQuestion: request })])), "先留着");
    expect(runner.answerQuestion).toHaveBeenCalledWith("00000000-0000-4000-8000-0000000000a1", "q-1", { choices: [[]], text: "先留着" });
    expect(runner.sendMessage).not.toHaveBeenCalled();
  });

  it("等前面的卡：已排队、写等哪几张，还没有分支", () => {
    const cards = new Map([["c0", { id: "c0", title: "先搭骨架" } as never]]);
    const worker = toWorker(item({ stage: "todo", queueReason: "not_dispatched" }), { sessions: [session({ status: "queued", waitingFor: ["c0"], queuePosition: 1 })], cards, deviceName: null });
    expect(worker).toMatchObject({ state: "queued", reason: "after", waitingFor: ["先搭骨架"], workspace: null });
    // 手机和别的电脑上照云端行：排队原因 prior_cards，等的卡带标题。
    const remote = toWorker(item({ stage: "todo", queueReason: "prior_cards", waitingFor: [{ cardId: "c0", title: "先搭骨架" }] }), ctx());
    expect(remote).toMatchObject({ state: "queued", reason: "after", waitingFor: ["先搭骨架"] });
  });

  it("假本机程序：批准以后问一个单选问题，答了接着做；答过再答是 409。「验收后自动合并」关着时验收过了记 needsMerge；带 after 的卡等前面的卡合回才开工作树、开始", async () => {
    vi.useFakeTimers();
    const runner = createMockRunner({ stepMs: 10 });
    await runner.patchSettings({ autoMerge: false });
    const first = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "Skeleton", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const second = await runner.createSession({ subject: { kind: "card", cardId: "c2" }, title: "Rows", cwd: "C:\\work\\tianshu", firstMessage: "交代", after: ["c1"] });
    expect(second).toMatchObject({ status: "queued", waitingFor: ["c1"] });
    expect(second.workspace).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60);
    const pending = (await runner.getSession(first.id)).pendingPermissions[0]!;
    await runner.decidePermission(first.id, pending.requestId, { decision: "allow" });
    await vi.advanceTimersByTimeAsync(30);
    const asked = (await runner.getSession(first.id)).session;
    expect(asked.status).toBe("idle");
    expect(asked.pendingQuestion?.questions[0]).toMatchObject({ header: "安装说明", options: [{ label: "删掉" }, { label: "留着" }] });
    await runner.answerQuestion(first.id, asked.pendingQuestion!.requestId, { choices: [["删掉"]] });
    await expect(runner.answerQuestion(first.id, asked.pendingQuestion!.requestId, { choices: [["删掉"]] })).rejects.toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(200);
    expect((await runner.getSession(first.id)).session.workspace).toMatchObject({ mergedCommit: null, needsMerge: { reason: "auto_merge_off" } });
    await runner.mergeSession(first.id);
    await runner.mergeSession(first.id);
    expect((await runner.getSession(first.id)).session.workspace).not.toHaveProperty("needsMerge");
    const started = (await runner.getSession(second.id)).session;
    expect(started.waitingFor).toBeUndefined();
    expect(started.workspace).toMatchObject({ kind: "worktree", branch: "tianshu/c2-rows" });
    expect(started.status).not.toBe("queued");
    vi.useRealTimers();
  });

  it("「验收后自动合并」开着（默认）：交回、验收员收工以后自己合回，等它的卡接着开工作树", async () => {
    vi.useFakeTimers();
    const runner = createMockRunner({ stepMs: 10 });
    const first = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "Skeleton", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const second = await runner.createSession({ subject: { kind: "card", cardId: "c2" }, title: "Rows", cwd: "C:\\work\\tianshu", firstMessage: "交代", after: ["c1"] });
    await vi.advanceTimersByTimeAsync(60);
    await runner.decidePermission(first.id, (await runner.getSession(first.id)).pendingPermissions[0]!.requestId, { decision: "allow" });
    await vi.advanceTimersByTimeAsync(30);
    await runner.answerQuestion(first.id, (await runner.getSession(first.id)).session.pendingQuestion!.requestId, { choices: [["删掉"]] });
    await vi.advanceTimersByTimeAsync(200);
    expect((await runner.getSession(first.id)).session.workspace).toMatchObject({ mergedCommit: expect.any(String) });
    expect((await runner.getSession(second.id)).session.workspace).toMatchObject({ kind: "worktree", branch: "tianshu/c2-rows" });
    vi.useRealTimers();
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

  it("排队先后：验收员、规划员、执行的；执行的交回以后本机自己接一个验收员，规划员、验收员交完收工（done）", async () => {
    vi.useFakeTimers();
    const runner = createMockRunner({ stepMs: 10, onPlanned: vi.fn() });
    await runner.patchSettings({ maxConcurrent: 1 });
    const card = (id: string): TLocalCreateSessionRequest => ({ subject: { kind: "card", cardId: id }, title: id, cwd: "C:\work\tianshu", firstMessage: "交代" });
    const [first, second, planner, verifier] = await Promise.all([
      runner.createSession(card("c1")),
      runner.createSession(card("c2")),
      runner.createSession({ subject: { kind: "plan", taskId: "t1" }, title: "拆卡", firstMessage: "拆" }),
      runner.createSession({ subject: { kind: "verify", cardId: "c0" }, title: "验收", firstMessage: "验" }),
    ]);
    const position = async (id: string) => (await runner.listSessions()).find((s) => s.id === id)?.queuePosition;
    expect(first!.status).toBe("starting");
    expect([await position(verifier!.id), await position(planner!.id), await position(second!.id)]).toEqual([1, 2, 3]);
    await runner.kill(first!.id);
    expect((await runner.listSessions()).find((s) => s.id === verifier!.id)?.status).toBe("starting");
    await vi.advanceTimersByTimeAsync(200);
    const status = async (id: string) => (await runner.listSessions()).find((s) => s.id === id)?.status;
    expect(await status(verifier!.id)).toBe("done");
    expect(await status(planner!.id)).toBe("done");
    // 执行的跑到权限请求：批准、回答一句，交回后接上 c2 的验收员。
    await vi.advanceTimersByTimeAsync(100);
    const pending = (await runner.getSession(second!.id)).pendingPermissions[0]!;
    await runner.decidePermission(second!.id, pending.requestId, { decision: "allow" });
    await vi.advanceTimersByTimeAsync(100);
    await runner.sendMessage(second!.id, "删掉");
    await vi.advanceTimersByTimeAsync(100);
    const chained = (await runner.listSessions()).find((s) => s.subject.kind === "verify" && s.subject.cardId === "c2");
    expect(chained).toBeDefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(await status(chained!.id)).toBe("done");
    vi.useRealTimers();
  });
});
