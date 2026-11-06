import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardDraftView, TTaskCard, TTaskView, THomePlanTask } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/me/month/tasks/t1" }));
const cloud = vi.hoisted(() => ({ markReturned: vi.fn(async () => ({})) }));
vi.mock("@/lib/board/cloud", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/board/cloud")>()), markReturned: cloud.markReturned }));

import { boardCards, canCommand, canStartCard, sortCell, type CardItem } from "@/lib/board/cards";
import { resetAutoReturn, returnsToSend, sendReturns } from "@/lib/board/useAutoReturn";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import type { LocalRunner, TLocalSessionSummary } from "@/lib/local/runner";
import { SessionTranscript } from "@/components/cards/SessionTranscript";
import { BoardView } from "./BoardView";

/** 不带卡：老事项（stageOf 按 status 放）。 */
const base: Omit<TTaskView, "card"> = {
  id: "x", version: 1, title: "x", status: "not_started", source: "self", startDate: null, dueDate: null, doneDefinition: "做完", mission: null, waitingOn: null,
  owner: { personId: "p1", name: "孙铭泽" }, collaborators: [], latestProgress: null, returnReason: null, origin: null, awaitingAcceptance: false, planTaskId: "t1", blocker: null,
  createdAt: "2026-11-06T01:00:00Z", updatedAt: "2026-11-06T01:00:00Z",
};
const facet = (card: Partial<TTaskCard>): TTaskCard => ({ stage: "todo", wait: null, executor: "claude_code", role: null, model: null, criterion: null, run: null, handback: null, deliverable: null, after: [], ...card });
const item = (id: string, card: Partial<TTaskCard> | null, extra: Partial<TTaskView> = {}): CardItem => ({ ...base, id, title: `卡 ${id}`, ...extra, ...(card ? { card: facet(card) } : {}) }) as CardItem;
const task: THomePlanTask = { taskId: "t1", missionId: "m1", name: "看板与派活跑通", doneDefinition: null, criteria: ["能拆卡", "能开工"], responsibleId: null };
const draft: TCardDraftView = { id: "00000000-0000-4000-8000-0000000000d1", planId: "00000000-0000-4000-8000-0000000000a1", position: 0, title: "草稿一", brief: "", doneDefinition: "完成", criterionIndex: 1, executor: "claude_code", modelTier: "normal", why: null, role: null, suggestPresetKey: null };
const board = (cards: CardItem[], drafts: TCardDraftView[] = []): TaskBoard => ({ taskId: "t1", criteria: [{ index: 1, text: "能拆卡" }, { index: 2, text: "能开工" }], cards, drafts, plan: null, pending: [], nextVersion: 2, fallback: false });
const session = (cardId: string, extra: Partial<TLocalSessionSummary> = {}): TLocalSessionSummary => ({
  id: `00000000-0000-4000-8000-00000000${cardId.padStart(4, "0")}`, subject: { kind: "card", cardId }, title: cardId, agent: "claude-code", modelProfileId: "subscription", modelLabel: "订阅",
  cwd: "C:\\w", status: "running", includePersonalConfig: false, createdAt: "2026-11-06T01:00:00Z", updatedAt: "2026-11-06T01:00:00Z", lastSeq: 1, pendingPermissions: 0, queuePosition: null,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }, ...extra,
});

/** 某一列里的卡（按出现顺序）。 */
const column = (html: string, stage: string) => {
  const start = html.indexOf(`data-stage="${stage}"`);
  const rest = html.slice(start + 1);
  const next = rest.search(/data-stage="|data-testid="deliverable-column"/);
  return html.slice(start, start + 1 + (next < 0 ? rest.length : next));
};
const ids = (html: string) => [...html.matchAll(/data-card="([^"]+)"/g)].map((match) => match[1]);

describe("Task 页看板", () => {
  it("四列加交付物：按 card.stage 放；老事项按 status；带标记的排在格子最上面；草稿是虚线", () => {
    const cards = boardCards([
      item("a", { stage: "doing" }),
      item("b", { stage: "doing", wait: "approval" }),
      item("c", { stage: "review" }),
      item("d", { stage: "done", deliverable: { state: "pending", versionNumber: 2 } }),
      item("e", { stage: "todo" }),
      item("old", null, { status: "in_progress" }),
    ]);
    const html = renderToStaticMarkup(<BoardView board={board(cards.map((card) => card.item), [draft])} task={task} cards={cards} canStart={() => false} deviceId={null} now={Date.parse("2026-11-06T02:00:00Z")} onStart={vi.fn()} onChanged={vi.fn()} />);
    expect([...html.matchAll(/data-stage="(\w+)"/g)].map((m) => m[1])).toEqual(["todo", "doing", "review", "done"]);
    expect(html).toContain('data-testid="deliverable-column"');
    expect(ids(column(html, "doing"))).toEqual(["b", "a", "old"]);
    expect(ids(column(html, "review"))).toEqual(["c"]);
    expect(ids(column(html, "done"))).toEqual(["d"]);
    expect(column(html, "done")).toContain("v2 准备中");
    expect(html).toMatch(/data-draft[^>]*data-testid="draft-card"/);
    expect(column(html, "todo")).toContain("放进看板");
    expect(column(html, "doing")).toContain("等你批准");
  });

  it("格子里的顺序：等你批准、等你回复在前，受阻在最后，其余照原样", () => {
    const cards = boardCards([item("1", { stage: "doing" }), item("2", { stage: "doing", wait: "blocked" }), item("3", { stage: "doing", wait: "reply" }), item("4", { stage: "doing", wait: "approval" })]);
    expect(sortCell(cards).map((card) => card.item.id)).toEqual(["4", "3", "2", "1"]);
  });

  it("本机在跑这张卡时，执行过程以本机为准：权限挂着就是等你批准", () => {
    const [card] = boardCards([item("a", { stage: "doing", wait: "reply" })], [session("a", { status: "waiting_permission", pendingPermissions: 1 })]);
    expect(card!.wait).toBe("approval");
    const [failed] = boardCards([item("b", { stage: "doing", wait: "review_failed" })], [session("b", { status: "idle" })]);
    expect(failed!.wait).toBe("review_failed");
  });
});

describe("手机宽度只能看", () => {
  it("没有开始、插话、批准：能不能指挥本机只看连着、不是手机", () => {
    const agent = item("a", { stage: "todo" });
    expect(canStartCard({ ready: true, handheld: false, item: agent })).toBe(true);
    expect(canStartCard({ ready: true, handheld: true, item: agent })).toBe(false);
    expect(canStartCard({ ready: true, handheld: false, item: item("s", { stage: "todo", executor: "self" }) })).toBe(false);
    expect(canCommand({ ready: true, handheld: true, hasSession: true })).toBe(false);
    expect(canCommand({ ready: true, handheld: false, hasSession: false })).toBe(false);
  });
  it("看板上的卡不给「开始」，权限请求只显示不给按钮", () => {
    const cards = boardCards([item("a", { stage: "todo" })]);
    const html = renderToStaticMarkup(<BoardView board={board(cards.map((card) => card.item))} task={task} cards={cards} canStart={(card) => canStartCard({ ready: true, handheld: true, item: card.item })} deviceId={null} now={0} onStart={vi.fn()} onChanged={vi.fn()} />);
    expect(column(html, "todo")).not.toContain(">开始<");
    const request = { requestId: "r", toolName: "Bash", title: "运行 pnpm test", input: {}, outsidePaths: [] as string[], canAllowForSession: true, requestedAt: "2026-11-06T01:00:00Z" };
    const transcript = (canAct: boolean, extra: Partial<typeof request> = {}) =>
      renderToStaticMarkup(<SessionTranscript entries={[{ kind: "permission", seq: 1, at: request.requestedAt, request: { ...request, ...extra }, decision: null }]} agentName="Claude Code" canAct={canAct} onDecide={vi.fn()} />);
    expect(transcript(false)).toContain("运行 pnpm test");
    expect(transcript(false)).not.toContain("批准");
    expect(transcript(true)).toContain("批准");
    expect(transcript(true)).toContain("这张卡都允许");
    // 越界：标红写出路径，只能允许这一次。
    const outside = transcript(true, { outsidePaths: ["C:\\Users\\me\\.ssh\\id_rsa"], canAllowForSession: false });
    expect(outside).toContain("data-outside");
    expect(outside).toContain("越界：C:\\Users\\me\\.ssh\\id_rsa");
    expect(outside).toContain("允许这一次");
    expect(outside).not.toContain("这张卡都允许");
  });
});

describe("验收未过：本机连着时自动把改法送过去，只送一次", () => {
  beforeEach(() => { resetAutoReturn(); cloud.markReturned.mockClear(); });
  const failed = (returnedAt: string | null = null) => item("a", { stage: "doing", wait: "review_failed", handback: {
    id: "00000000-0000-4000-8000-0000000000b1", attempt: 1, status: "done", outcome: "fail", met: 1, total: 2, headline: null,
    returnText: "验收没过：第 2 条……改完再交回。", returnedAt, overruled: false, createdAt: "2026-11-06T01:00:00Z", finishedAt: "2026-11-06T01:02:00Z", git: null,
  } });
  const runner = () => ({ sendMessage: vi.fn(async () => ({ delivery: "resumed" as const })) }) as unknown as LocalRunner & { sendMessage: ReturnType<typeof vi.fn> };

  it("这台电脑上有这张卡的会话才送；送完记一笔 returned；再看一次不再送", async () => {
    const local = runner();
    expect(returnsToSend([failed()], [])).toEqual([]);
    expect(await sendReturns(local, [failed()], [session("a", { status: "exited" })])).toBe(1);
    expect(local.sendMessage).toHaveBeenCalledWith(session("a").id, "验收没过：第 2 条……改完再交回。");
    expect(cloud.markReturned).toHaveBeenCalledWith("a", "00000000-0000-4000-8000-0000000000b1");
    expect(await sendReturns(local, [failed()], [session("a", { status: "exited" })])).toBe(0);
    expect(local.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("已经送到过（returnedAt 有值）不再送；本机没接住下次再送", async () => {
    const local = runner();
    expect(await sendReturns(local, [failed("2026-11-06T01:03:00Z")], [session("a")])).toBe(0);
    local.sendMessage.mockRejectedValueOnce(new Error("连不上"));
    expect(await sendReturns(local, [failed()], [session("a")])).toBe(0);
    expect(await sendReturns(local, [failed()], [session("a")])).toBe(1);
  });
});
