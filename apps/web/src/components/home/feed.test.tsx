import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TWorkerItem } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { toWorker, type Worker } from "@/lib/work/workers";
import type { FeedItem } from "@/lib/home/types";
import { feedBlocks } from "./TaskFeed";

const ROLE = { id: "00000000-0000-4000-8000-000000000001", name: "开发", kind: "worker" as const };
const CARD = "00000000-0000-4000-8000-0000000000c1";
const HANDBACK = "00000000-0000-4000-8000-0000000000e1";
const item = (extra: Partial<TWorkerItem>): TWorkerItem => ({
  key: `card:${CARD}`, kind: "card", cardId: CARD, topicId: null, title: "greet", role: ROLE, workerNo: 1,
  task: { id: "t1", name: "11/30 上线 V2" }, mission: null, step: null,
  resource: { where: "local", deviceId: null, deviceName: "ThinkPad", modelLabel: "Sonnet" }, startedAt: "2026-11-07T04:00:00Z", elapsedSeconds: 60,
  finishedAt: null, cost: null, stage: "doing", wait: null, needsYou: false, queueReason: null, queuePosition: null, git: null, waitingFor: [], ...extra,
});
const session = (extra: Partial<TLocalSessionSummary>): TLocalSessionSummary => ({
  id: "00000000-0000-4000-8000-0000000000a1", subject: { kind: "card", cardId: CARD }, title: "greet", agent: "claude-code", modelProfileId: "subscription", modelLabel: "Sonnet",
  cwd: "C:\\w", status: "idle", includePersonalConfig: false, createdAt: "2026-11-07T04:00:00Z", updatedAt: "2026-11-07T04:10:00Z", lastSeq: 3, pendingPermissions: 0,
  queuePosition: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null }, ...extra,
});
const local = (sessions: TLocalSessionSummary[]) => ({ runner: createMockRunner(), phase: "ready", version: null, status: null, models: [], folders: [], sessions, pairing: null, error: null,
  refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() }) as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (items: FeedItem[], workers: Worker[], sessions: TLocalSessionSummary[] = []) => {
  const blocks = feedBlocks({ items, workers, taskId: "t1", go: vi.fn(), onSay: vi.fn(), onChanged: vi.fn() });
  const node: ReactNode = <>{blocks.map((block) => <div key={block.key}>{block.node}</div>)}</>;
  return { blocks, html: renderToStaticMarkup(<LocalContext.Provider value={local(sessions)}>{node}</LocalContext.Provider>) };
};
const passedWorker = (handback: Record<string, unknown> = {}): Worker => ({
  ...toWorker(item({ stage: "done", finishedAt: "2026-11-07T05:00:00Z" }), { sessions: [], cards: new Map(), deviceName: null }),
  item: { id: CARD, card: { handback: { id: HANDBACK, attempt: 1, status: "done", outcome: "pass", met: 5, total: 5, overruled: false, ...handback } } } as unknown as Worker["item"],
});

describe("Task 管线里的验收行（第 4.5 条）", () => {
  it("过了：一行「greet 验收过了（5/5），已合进 main」，行尾能推翻", () => {
    const { html } = render([{ kind: "card_passed", id: "p1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", met: 5, total: 5,
      merge: { state: "merged", commit: "abc", baseBranch: "main", reason: null, message: null, at: "2026-11-07T05:01:00Z" } }], [passedWorker()]);
    expect(text(html)).toContain("「greet」验收过了（5/5），已合进 main");
    expect(text(html)).toContain("推翻");
  });

  it("推翻过的、或看板上没有这次交回的，不给推翻", () => {
    const item = { kind: "card_passed" as const, id: "p1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", met: 5, total: 5, merge: null };
    expect(text(render([item], [passedWorker({ overruled: true })]).html)).not.toContain("推翻");
    expect(text(render([item], []).html)).not.toContain("推翻");
  });

  it("过了没合回：这台电脑上有那张卡的会话才问「合进 main（推荐）/ 先不合」，别处那一行写还没合回", () => {
    const item: FeedItem = { kind: "card_passed", id: "p1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", met: 5, total: 5,
      merge: { state: "needs_merge", commit: null, baseBranch: "main", reason: "dirty", message: "主文件夹有没提交的改动", at: "2026-11-07T05:01:00Z" } };
    const elsewhere = render([item], [passedWorker()]);
    expect(elsewhere.blocks).toHaveLength(1);
    expect(text(elsewhere.html)).toContain("还没合回");
    const here = session({ workspace: { kind: "worktree", folder: "C:\\w", path: "C:\\w\\.wt", branch: "tianshu/greet", baseBranch: "main", baseCommit: "a".repeat(40), mergedCommit: null } });
    const onThis = render([item], [{ ...passedWorker(), session: here }], [here]);
    expect(onThis.blocks.map((block) => block.key)).toEqual(["p1", "p1:merge"]);
    expect(text(onThis.html)).toMatch(/合进 main.*推荐.*先不合/);
  });

  it("受阻：「按这个改（推荐）/ 我去看看 / 仍然通过」，改法写在框里；不在这台电脑上没有「按这个改」", () => {
    const blocked: FeedItem = { kind: "card_blocked", id: "b1", at: "2026-11-07T05:00:00Z", cardId: CARD, title: "greet", handbackId: HANDBACK, fix: "补上 404 的处理" };
    const here = session({});
    const onThis = text(render([blocked], [{ ...passedWorker(), session: here }], [here]).html);
    expect(onThis).toMatch(/「greet」受阻.*补上 404 的处理.*按这个改.*推荐.*我去看看.*仍然通过/);
    const elsewhere = text(render([blocked], [passedWorker()]).html);
    expect(elsewhere).not.toContain("按这个改");
    expect(elsewhere).toMatch(/我去看看.*仍然通过/);
  });

  it("约定都达到：问「约定 3 条都达到了，交给认可人？」，交给认可人推荐、先不交、自己说", () => {
    const html = text(render([{ kind: "criteria_met", id: "c1", at: "2026-11-07T06:00:00Z", met: 3, total: 3 }], []).html);
    expect(html).toMatch(/约定 3 条都达到了，交给认可人？.*交给认可人.*推荐.*先不交.*自己说…/);
  });

  it("合回以后被推翻：一行「推翻了，开了返工「greet 返工」」，带理由", () => {
    const html = text(render([{ kind: "rework_opened", id: "r1", at: "2026-11-07T07:00:00Z", cardId: CARD, title: "greet 返工", fromCardId: CARD, reason: "返回值不对" }], []).html);
    expect(html).toContain("推翻了，开了返工「greet 返工」");
    expect(html).toContain("返回值不对");
  });
});
