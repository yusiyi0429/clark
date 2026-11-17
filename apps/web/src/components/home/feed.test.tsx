import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TWorkerItem } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { toWorker, type Worker } from "@/lib/work/workers";
import type { FeedItem, SubSession } from "@/lib/home/types";
import { GoalChangeDecision, feedBlocks } from "./TaskFeed";
import { conversationFeed } from "./Conversations";

const ROLE = { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" as const };
const CARD = "00000000-0000-4000-8000-0000000000c1";
const HANDBACK = "00000000-0000-4000-8000-0000000000e1";
const item = (extra: Partial<TWorkerItem>): TWorkerItem => ({
  key: `card:${CARD}`, kind: "card", cardId: CARD, topicId: null, title: "greet", role: ROLE, workerNo: 1,
  task: { id: "t1", name: "11/30 上线 V2" }, mission: null, step: null,
  resource: { where: "local", deviceId: null, deviceName: "ThinkPad", modelLabel: "Sonnet" }, startedAt: "2026-11-07T04:00:00Z", elapsedSeconds: 60,
  finishedAt: null, cost: null, stage: "doing", wait: null, needsYou: false, queueReason: null, holdUntil: null, queuePosition: null, git: null, waitingFor: [], ...extra,
});
const session = (extra: Partial<TLocalSessionSummary>): TLocalSessionSummary => ({ permissionMode: "auto",
  id: "00000000-0000-4000-8000-0000000000a1", subject: { kind: "card", cardId: CARD }, title: "greet", agent: "claude-code", modelProfileId: "subscription", modelLabel: "Sonnet",
  cwd: "C:\\w", status: "idle", includePersonalConfig: false, createdAt: "2026-11-07T04:00:00Z", updatedAt: "2026-11-07T04:10:00Z", lastSeq: 3, pendingPermissions: 0,
  queuePosition: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }, ...extra,
});
const local = (sessions: TLocalSessionSummary[]) => ({ runner: createMockRunner(), phase: "ready", version: null, status: null, models: [], folders: [], sessions, pairing: null, error: null,
  refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() }) as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (items: FeedItem[], workers: Worker[], sessions: TLocalSessionSummary[] = []) => {
  const blocks = feedBlocks({ items, workers, go: vi.fn(), onSay: vi.fn(), onChanged: vi.fn() });
  const node: ReactNode = <>{blocks.map((block) => <div key={block.key}>{block.node}</div>)}</>;
  return { blocks, html: renderToStaticMarkup(<LocalContext.Provider value={local(sessions)}>{node}</LocalContext.Provider>) };
};
const passedWorker = (handback: Record<string, unknown> = {}): Worker => ({
  ...toWorker(item({ stage: "done", finishedAt: "2026-11-07T05:00:00Z" }), { sessions: [], cards: new Map(), deviceName: null }),
  item: { id: CARD, card: { handback: { id: HANDBACK, attempt: 1, status: "done", outcome: "pass", met: 5, total: 5, overruled: false, ...handback } } } as unknown as Worker["item"],
});

describe("Task 管线里的验收行（第 4.5 条）", () => {
  it("过了：一句「greet 验收过了（5/5），已合进 main」，行尾能推翻", () => {
    const { html } = render([{ kind: "card_passed", id: "p1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", met: 5, total: 5,
      merge: { state: "merged", commit: "abc", baseBranch: "main", reason: null, message: null, at: "2026-11-07T05:01:00Z" } }], [passedWorker()]);
    expect(text(html)).toContain("greet 验收过了（5/5），已合进 main");
    expect(text(html)).toContain("推翻");
  });

  it("推翻过的、或看板上没有这次交回的，不给推翻", () => {
    const item = { kind: "card_passed" as const, id: "p1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", met: 5, total: 5, merge: null };
    expect(text(render([item], [passedWorker({ overruled: true })]).html)).not.toContain("推翻");
    expect(text(render([item], []).html)).not.toContain("推翻");
  });

  it("过了没合回：这台电脑上有那张卡的会话才问「合进 main（推荐）/ 先不合」，别处那一句写无法合回", () => {
    const item: FeedItem = { kind: "card_passed", id: "p1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", met: 5, total: 5,
      merge: { state: "needs_merge", commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", at: "2026-11-07T05:01:00Z" } };
    const elsewhere = render([item], [passedWorker()]);
    expect(elsewhere.blocks).toHaveLength(1);
    expect(text(elsewhere.html)).toContain("无法合回");
    const here = session({ workspace: { kind: "worktree", folder: "C:\\w", path: "C:\\w\\.wt", branch: "tianshu/greet", baseBranch: "main", baseCommit: "a".repeat(40), mergedCommit: null,
      needsMerge: { reason: "not_ready", message: "交回以后卡又改过" } } });
    const onThis = render([item], [{ ...passedWorker(), session: here }], [here]);
    expect(onThis.blocks.map((block) => block.key)).toEqual(["p1", "p1:merge"]);
    expect(text(onThis.html)).toMatch(/合进 main.*推荐.*先不合/);
    expect(text(onThis.html)).toContain("交回以后卡又改过");
  });

  it("受阻（主循环第 62 条）：「再改一轮（推荐）/ 我去看看 / 改完成标准 / 就到这里」，验收意见收起；不在这台电脑上选项一个不少", () => {
    const blocked: FeedItem = { kind: "card_blocked", id: "b1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", handbackId: HANDBACK, fix: "补上 404 的处理",
      sourceWordIssues: [{ quote: "别动登录", kind: "extra", reason: "改了登录页" }, { quote: "要有 404", kind: "missing", reason: "没处理 404" }] };
    const here = session({});
    const onThis = text(render([blocked], [{ ...passedWorker(), session: here }], [here]).html);
    expect(onThis).toMatch(/验收两次没过.*验收意见.*再改一轮.*推荐.*我去看看.*改完成标准.*就到这里/);
    // 改法、原话对不上的几处都收在「验收意见」里，默认不展开。
    expect(onThis).not.toContain("补上 404 的处理");
    expect(onThis).not.toContain("仍然通过");
    const elsewhere = text(render([blocked], [passedWorker()]).html);
    expect(elsewhere).toMatch(/再改一轮.*推荐.*我去看看.*改完成标准.*就到这里/);
  });

  it("约定都达到：问「约定 3 条都达到了，交给认可人？」，交给认可人推荐、先不交、自己说", () => {
    const raw = render([{ kind: "criteria_met", id: "c1", at: "2026-11-07T06:00:00Z", taskId: "t1", met: 3, total: 3 }], []).html;
    expect(text(raw)).toMatch(/约定 3 条都达到了，交给认可人？.*交给认可人.*推荐.*先不交/);
    expect(raw).toContain('placeholder="自己说…"');
  });

  it("约定都达到答过了：项目对话里不再留这一块（本人 11/16：项目对话只留对话本身）", () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ c1: "交给认可人" }), setItem: () => undefined });
    try {
      expect(render([{ kind: "criteria_met", id: "c1", at: "2026-11-07T06:00:00Z", taskId: "t1", met: 3, total: 3 }], []).html).not.toContain("约定 3 条都达到了");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("合回以后被推翻：一行「推翻了，开了返工「greet 返工」」，带理由", () => {
    const html = text(render([{ kind: "rework_opened", id: "r1", at: "2026-11-07T07:00:00Z", cardId: CARD, title: "greet 返工", fromCardId: CARD, reason: "返回值不对" }], []).html);
    expect(html).toContain("推翻了，开了返工「greet 返工」");
    expect(html).toContain("返回值不对");
  });
});

describe("子会话的提问由 Task 管线转达（14.3）", () => {
  const asking = (extra: Partial<TLocalSessionSummary>) => session({ status: "idle", pendingQuestion: { requestId: "q1", askedAt: "2026-11-07T04:09:00Z", questions: [{ question: "用哪个库？", header: "", multiSelect: false, options: [{ label: "zod (Recommended)", description: "" }, { label: "yup", description: "" }] }] }, ...extra });
  it("这台电脑上的子会话在问：Task 管线里出选项框，框顶上写子会话名", () => {
    const here = asking({});
    const { blocks, html } = render([], [{ ...passedWorker(), session: here }], [here]);
    expect(blocks.map((block) => block.key)).toEqual([`ask:card:${CARD}`]);
    expect(text(html)).toMatch(/greet 用哪个库？.*zod.*推荐.*yup/);
  });
  it("没在问、也不在跑的子会话不占位置", () => {
    const idle = session({});
    expect(render([], [{ ...passedWorker(), session: idle }], [idle]).blocks).toHaveLength(0);
  });
});

describe("子会话停了、要人介入，报给项目主管线（18.10）", () => {
  const sub = { kind: "card" as const, id: CARD, letter: "B", title: "greet" };
  it("要介入：决定卡排在云端记下的位置，只写名字不标字母（本人 11/16）；本机那块不再重复出；答过的（closed）不画", () => {
    const here = session({ status: "idle", pendingQuestion: { requestId: "q1", askedAt: "2026-11-07T04:09:00Z", questions: [{ question: "用哪个库？", header: "", multiSelect: false, options: [{ label: "zod", description: "" }] }] } });
    const decision = { kind: "sub_session_decision" as const, id: "d1", at: "2026-11-07T04:09:30Z", afterSequence: 7, sub, sessionId: here.id, deviceId: "00000000-0000-4000-8000-0000000000d1",
      question: here.pendingQuestion!, permission: null, status: "open" as const, closedAt: null };
    const workers = [{ ...passedWorker(), session: here }];
    const blocks = feedBlocks({ items: [], workers, go: vi.fn(), onSay: vi.fn(), onChanged: vi.fn(), decisions: [decision] });
    expect(blocks.map((block) => [block.key, block.afterSequence])).toEqual([["d1", 7]]);
    const html = renderToStaticMarkup(<LocalContext.Provider value={local([here])}>{blocks[0]!.node}</LocalContext.Provider>);
    expect(html).toMatch(/greet.*用哪个库？/);
    expect(html).not.toContain("sub-letter");
    const closed = feedBlocks({ items: [], workers, go: vi.fn(), onSay: vi.fn(), onChanged: vi.fn(), decisions: [{ ...decision, status: "closed", closedAt: "2026-11-07T04:20:00Z" }] });
    expect(closed.map((block) => block.key)).toEqual([`ask:card:${CARD}`]);
  });
});

describe("月中 Task 改了或取消了（16.4，goal_changed）", () => {
  const change = (patch: Record<string, unknown> = {}) => ({ kind: "goal_changed" as const, id: "00000000-0000-4000-8000-0000000000f9", at: "2026-11-15T02:00:00Z", taskId: "t1",
    taskName: "回答的样子", change: "cancelled" as const, sessions: [{ kind: "card" as const, id: CARD, title: "greet" }, { kind: "topic" as const, id: HANDBACK, title: "查评测集" }],
    answer: null, answeredAt: null, ...patch });
  const draw = (item: ReturnType<typeof change>) => text(renderToStaticMarkup(<LocalContext.Provider value={local([])}>
    <GoalChangeDecision projectId="00000000-0000-4000-8000-0000000000f1" item={item} onChanged={vi.fn()} /></LocalContext.Provider>));
  it("还没答：「Task 取消了」，停掉（推荐）/ 留着，下面列出还没做完的子会话；锚点给等你那一行用", () => {
    const html = draw(change());
    expect(html).toMatch(/回答的样子：Task 取消了.*greet.*查评测集.*停掉.*推荐.*留着/);
    expect(renderToStaticMarkup(<LocalContext.Provider value={local([])}><GoalChangeDecision projectId="p" item={change({ change: "changed" })} onChanged={vi.fn()} /></LocalContext.Provider>))
      .toContain('id="goal-00000000-0000-4000-8000-0000000000f9"');
    expect(draw(change({ change: "changed" }))).toContain("回答的样子：Task 改了");
  });
  it("答过的收成一行", () => {
    const html = draw(change({ answer: "keep", answeredAt: "2026-11-15T03:00:00Z" }));
    expect(html).toContain("留着");
    expect(html).not.toContain("推荐");
  });
});

describe("要你出手的事回到项目对话（设计 4.3 硬规矩，本人 11/17）", () => {
  const CARD2 = "00000000-0000-4000-8000-0000000000c2";
  const CARD3 = "00000000-0000-4000-8000-0000000000c3";
  const TOPIC = "00000000-0000-4000-8000-0000000000d4";
  const sub = (id: string, title: string, extra: Partial<SubSession> = {}) => ({
    id, kind: "card", letter: null, title, state: "waiting", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
    sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-17T01:00:00.000Z", merge: null, ...extra,
  }) as unknown as SubSession;
  const blocked: FeedItem = { kind: "card_blocked", id: "b1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", handbackId: HANDBACK, fix: "补上 404 的处理", sourceWordIssues: [] };
  const needs: FeedItem = { kind: "card_needs_person", id: "n1", at: "2026-11-07T05:10:00Z", cardId: CARD2, title: "登录页", handbackId: HANDBACK, fix: null, sourceWordIssues: [] };
  const merge: FeedItem = { kind: "card_passed", id: "p1", at: "2026-11-07T05:20:00Z", cardId: CARD3, title: "接口", met: 3, total: 3,
    merge: { state: "needs_merge", commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", at: "2026-11-07T05:21:00Z" } };
  const report = { kind: "sub_session_report" as const, id: "r1", at: "2026-11-07T05:30:00Z", afterSequence: 4, sub: { kind: "topic" as const, id: TOPIC, letter: "D", title: "调研" },
    why: "held" as const, summary: "查完了一半", blocker: "订阅额度用完了", outputs: [] };
  const open = [sub(CARD, "greet", { waiting: "verdict" }), sub(CARD2, "登录页", { waiting: "needs_person" }), sub(CARD3, "接口", { waiting: "merge" }),
    sub(TOPIC, "调研", { kind: "topic", stopWhy: "held" })];
  const draw = (items: Parameters<typeof feedBlocks>[0]["items"], subs: SubSession[]) => {
    const blocks = feedBlocks({ items, workers: [], go: vi.fn(), onSay: vi.fn(), onChanged: vi.fn(), threads: { subs, onOpen: vi.fn() } });
    return renderToStaticMarkup(<LocalContext.Provider value={local([])}>{blocks.map((block) => <div key={block.key}>{block.node}</div>)}</LocalContext.Provider>);
  };

  it("受阻、等合回、等你补、停下有原因的回到项目对话，带原来的按钮", () => {
    const html = draw([blocked, needs, merge, report], open);
    expect(text(html)).toMatch(/再改一轮.*推荐.*我去看看/);
    expect(text(html)).toContain("登录页 等你补");
    expect(text(html)).toContain("接口 验收过了（3/3），无法合回");
    expect(text(html)).toMatch(/调研 · 停着等.*查完了一半.*订阅额度用完了.*看结果/);
    // 每块下面挂这个子会话的小条。
    expect(html.match(/data-testid="thread-chip"/g)).toHaveLength(4);
  });

  it("同一个子会话只留最新一块，处理完收起", () => {
    // 同一张卡先受阻、后来等你补：只留等你补那一块。
    const later: FeedItem = { ...needs, id: "n2", cardId: CARD, title: "greet" };
    expect(conversationFeed([blocked, later]).map((entry) => entry.id)).toEqual(["n2"]);
    // 状态变了（不再受阻、不再等你补、合回了、又跑起来了）：收成一行淡色字，不再带按钮和小条。
    const moved = [sub(CARD, "greet", { state: "running" }), sub(CARD2, "登录页", { state: "running" }), sub(CARD3, "接口", { state: "done" }), sub(TOPIC, "调研", { kind: "topic", state: "running" })];
    const html = draw([blocked, needs, merge, report], moved);
    expect(html.match(/data-testid="hand-settled"/g)).toHaveLength(4);
    expect(text(html)).toMatch(/greet 受阻.*登录页 等你补.*接口 验收过了（3\/3），无法合回.*调研 · 停着等/);
    expect(text(html)).not.toContain("再改一轮");
    expect(text(html)).not.toContain("看结果");
    expect(html).not.toContain("thread-chip");
    // 本人点过「看结果」的报告也收起。
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ r1: "看结果" }), setItem: () => undefined });
    try {
      expect(draw([report], open)).toContain('data-testid="hand-settled"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
