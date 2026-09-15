/**
 * 一号位在待挑页上**确认**把一条信号升级成潜在议题。
 *
 * 钉的是四件在屏幕上看不出来的事：
 *
 *   · **当场就有**：确认那一下同步地建出议题、卡、预研，不等 A1a。屏幕上「潜在议题里
 *     立刻多出这一条」靠的就是它同步。
 *   · **标题是他确认的那一句**，不是信号标题、也不是模型的版本。
 *   · **这条信号从待挑列表里消失**（`disposedAs` 当场标上），而且不许立第二次案。
 *   · **A1a 随后只补正文**：议题已经在了，那一轮不再新建，把四块框架补到同一条上，
 *     而且**一个字都不许改标题**。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { applyA1aInbox } from "@/lib/agent/a1a/apply";
import type { AgentRunRecord, InboxSignal } from "./types";

process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

let api: typeof import("./store").api;
let inboxSignalsPut: typeof import("./store").inboxSignalsPut;

beforeAll(async () => {
  const mod = await import("./store");
  api = mod.api;
  inboxSignalsPut = mod.inboxSignalsPut;
});

/**
 * 投一条新的待挑信号，返回它的 key。
 *
 * **每条用例一个 key**：这几条共用同一个进程里的同一份库（模块只加载一次），
 * 而升级过的信号会被永久标上「开成了哪条议题」——复用一个 key 的话，第二条用例
 * 一进门就撞上那道「不许立两次案」的闸。
 */
let n = 0;
const seed = (): string => {
  n += 1;
  const key = `https://example.com/upgrade-${n}`;
  inboxSignalsPut([
    {
      kind: "crawled",
      runId: "s-test",
      scannedAt: "2026-08-30T01:00:00Z",
      dedupeKey: key,
      title: "某媒体给这篇稿子起的标题",
      url: key,
      text: "正文。",
      publishedAt: "2026-08-30T00:00:00Z",
      source: "example.com",
      origin: "discovered",
      score: 4.2,
      dimensions: { 假设关联: 5 },
      kiq: "KIQ1.1",
      why: "命中靶点",
      suggestedIssue: "首批客户按行业挑，还是按一号位是否真正牵引挑？",
    },
  ]);
  return key;
};

/** 拿到库里那条信号（`listInboxSignals` 过滤掉处置过的，所以不能用它查）。 */
const signalOf = async (key: string): Promise<InboxSignal | undefined> => {
  const { signals } = await api.listNominatedSignals();
  return signals.find((s) => s.dedupeKey === key);
};

describe("确认升级", () => {
  it("当场就建出议题和卡，标题用他确认的那一句", async () => {
    const key = seed();
    const { issueId } = await api.upgradeSignal(key, "我自己改过的那一句问题句？");

    const issues = await api.listIssues();
    const issue = issues.find((i) => i.id === issueId);
    expect(issue).toBeDefined();
    expect(issue!.state).toBe("Candidate");
    expect(issue!.origin).toBe("signal");
    // 不是信号标题、也不是「建议方向」——是他框里那一句。
    expect(issue!.title).toBe("我自己改过的那一句问题句？");

    // 卡当场就摊在潜在议题那一屏上。
    const cards = await api.listPending();
    const card = cards.find((c) => c.issueId === issueId);
    expect(card).toBeDefined();
    expect(card!.headline).toBe("我自己改过的那一句问题句？");
  });

  it("这条信号从待挑列表里消失，而且不许立第二次案", async () => {
    const key = seed();
    const { issueId } = await api.upgradeSignal(key, "第一次");

    const open = await api.listInboxSignals();
    expect(open.some((s) => s.dedupeKey === key)).toBe(false);

    // 台账那一页照旧看得见它，处置写着「开成议题」。
    const sig = await signalOf(key);
    expect(sig?.disposedAs).toBe("issue");
    expect(sig?.issueId).toBe(issueId);

    await expect(api.upgradeSignal(key, "第二次")).rejects.toThrow(issueId);
  });

  it("空标题不许过", async () => {
    await expect(api.upgradeSignal(seed(), "   ")).rejects.toThrow();
  });

  it("随后那一轮 A1a 只补正文，不新建、也不改标题", async () => {
    const key = seed();
    const { issueId } = await api.upgradeSignal(key, "他确认的那一句");
    const before = (await api.listIssues()).length;

    const sig = await signalOf(key);
    const run = {
      id: "R-test-1",
      status: "ok",
      route: "new_issue",
      output: {
        /* `readIssueFraming` 认的是这几个名字；`issue_statement` 读不到就整块判为没有。 */
        sharp_title: "模型自己起的标题",
        issue_statement: "模型写的那一句议题正文。",
        what_happened: "参谋读到的事实。",
        business_consequence: "若为真，某条判断要重估。",
      },
    } as unknown as AgentRunRecord;

    const res = applyA1aInbox(run, sig!);

    // 没有新建第二条。
    expect((await api.listIssues()).length).toBe(before);
    expect(res.issueId).toBe(issueId);
    expect(res.applied).toContain("补");

    // 标题一个字没动；卡面第二拍换成了参谋写的那一句。
    const issue = (await api.listIssues()).find((i) => i.id === issueId);
    expect(issue!.title).toBe("他确认的那一句");
    const card = (await api.listPending()).find((c) => c.issueId === issueId);
    expect(card!.headline).toBe("他确认的那一句");
    expect(card!.why).toBe("若为真，某条判断要重估。");
  });
});
