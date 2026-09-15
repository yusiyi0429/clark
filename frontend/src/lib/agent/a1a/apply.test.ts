// 必须在 import 之前设置：store.ts 模块求值期会 loadSnapshot 读开发机上 .data/store.json 里的真实数据，
// 不设这个开关测试会拿现场数据跑且不报错，断言结果跟着那个 gitignore 掉的文件飘。
process.env.TKOS_PERSIST = "0";
// 必须在 import 之前设置：这个文件现在有 8 处会起真的 A3 预研（每次 applyA1aInbox 建出议题 →
// issueFromSignal → ensurePreResearch，外加两次 api.addIssue），失败被 runTask 的 catch 吞掉，
// 所以全绿看不出来。不设这个开关就是 8 次真实模型调用，且后台任务会在后面的用例执行期间往同一个
// store 里写（store.preResearch、agentRunPut），引入时序依赖。
process.env.TKOS_MODEL_MOCK = "1";

import { describe, expect, it } from "vitest";

import { api } from "@/lib/data/store";
import type { AgentRunRecord, InboxSignal } from "@/lib/data/types";

import { applyA1aInbox, applyA1aResult, NotWiredYet } from "./apply";

const base = (over: Partial<AgentRunRecord>): AgentRunRecord =>
  ({
    id: "RUN-A1a-x",
    agent: "A1a",
    status: "ignored",
    input: "信号原文：X",
    output: {
      decision: "ignore",
      verdict: "此信号应被忽略，不改动也不新增议题",
      reason: "只有一个来源",
      what_would_change_it: "出现第二个独立来源",
    },
    route: "ignore",
    contextMode: "anchored",
    trace: [],
    checks: [],
    checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
    slot: "pro",
    modelAlias: "deepseek-pro",
    providerModelId: "ep-x",
    depth: "high",
    snapshotId: "ctx-x",
    contextRecipe: "S01",
    contextAnchor: "CARD-01",
    contextViewer: "PSN-01",
    contextAsOf: "2026-08-18",
    graphknowledgeBaseUrl: "https://example/graph",
    warnings: [],
    createdAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:00:01.000Z",
    latencyMs: 1,
    ...over,
  }) as AgentRunRecord;

describe("applyA1aResult", () => {
  it("ignore：信号留在列表里并被标注，没有被处置掉", async () => {
    // 自己先提一件 —— 上线第一天提请台是空的（`store.candidate.test.ts`），
    // 这里要的只是一张真卡，来路哪一条都行。
    await api.addIssue("A1a ignore 用的一条信号");
    const card = (await api.listPending())[0];
    const r = applyA1aResult(base({ input: card.id }), card.id);
    expect(r.applied).toContain("标注");
    const after = (await api.listPending()).find((x) => x.id === card.id);
    expect(after?.agentVerdict?.reasonToRevisit).toBe("出现第二个独立来源");
    expect(after?.disposedAs).toBeUndefined();
  });

  it("update_issue / new_issue 显式抛错，不静默 no-op", () => {
    // 静默 no-op 的话，屏幕上看不出「这条议题其实没进池子」——
    // Run 记录里躺着一份漂亮的产出，而议题列表一动不动。
    for (const route of ["update_issue", "new_issue"] as const) {
      expect(() => applyA1aResult(base({ status: "ok", route }), "CARD-01")).toThrow(NotWiredYet);
    }
  });

  it("failed 不写回任何东西", () => {
    const r = applyA1aResult(base({ status: "failed", route: undefined }), "CARD-01");
    expect(r.applied).toContain("未写回");
  });
});

/** 抓取那一支。分数、KIQ 那几个字段只有它有 —— 人报的那一支照它的形状填就得编。 */
const crawled = (over: Partial<InboxSignal> = {}): InboxSignal =>
  ({
    kind: "crawled",
    origin: "pinned",
    dedupeKey: "https://example.com/a",
    title: "大厂把 To B 的销售与交付合并成行业线",
    url: "https://example.com/a",
    text: "两家大厂本周把 To B 的销售与交付合并成行业线。",
    publishedAt: "2026-08-18T00:00:00.000Z",
    source: "第一财经",
    why: "招标季在三个月内开始",
    score: 4.6,
    dimensions: {},
    kiq: "KIQ2.2",
    suggestedIssue: "入口是否在移动",
    runId: "RUN-scan-1",
    scannedAt: "2026-08-18T00:00:00.000Z",
    receivedAt: "2026-08-18T01:00:00.000Z",
    ...over,
  }) as InboxSignal;

/** 人报那一支。可信度全在 `by` 那三个字上，所以卡上的 `source` 必须带上它。 */
const reported = (over: Partial<InboxSignal> = {}): InboxSignal =>
  ({
    kind: "reported",
    by: "赵磊",
    dedupeKey: "dri-abc123",
    title: "两个已投标客户的决策链换人了",
    url: "",
    text: "客户在电话里说采购决策已经交给行业线负责人。",
    publishedAt: "",
    source: "客户电话",
    why: "本周就要复标",
    receivedAt: "2026-08-18T01:00:00.000Z",
    ...over,
  }) as InboxSignal;

/** 判为值得、带正文的那一次运行。`base` 的默认值是 ignore 那一支。 */
const wrote = (out: Record<string, unknown>, route: "new_issue" | "update_issue" = "new_issue") =>
  base({ status: "ok", route, output: out });

const STATEMENT = "如果入口移到行业交付，我们靠模型能力建立的差异还剩多少？";

describe("applyA1aInbox", () => {
  it("new_issue + 抓取来的信号：开出一条 Candidate/signal 议题，卡的来路是雷达", async () => {
    const r = applyA1aInbox(wrote({ issue_statement: `  ${STATEMENT}  ` }), crawled());
    expect(r.issueId).toBeTruthy();

    const issue = await api.getIssue(r.issueId!);
    expect(issue.title).toBe(STATEMENT);
    expect(issue.state).toBe("Candidate");
    expect(issue.origin).toBe("signal");
    // 归域是之后的事，这里不猜 —— 没有域就是没有域。
    expect(issue.domainId).toBeUndefined();

    const card = (await api.listPending()).find((c) => c.issueId === issue.id);
    expect(card?.source).toEqual({ kind: "radar" });
    // 卡上第一段是信号原文，出处点得开。
    expect(card?.what[0]?.text).toBe(crawled().text);
    expect(card?.what[0]?.traces[0]?.href).toBe("https://example.com/a");
  });

  it("new_issue + 人报的信号：卡的来路带上上报人的姓名", async () => {
    const r = applyA1aInbox(wrote({ issue_statement: "决策链换人之后，我们的投标策略还成立吗？" }), reported());
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    expect(card?.source).toEqual({ kind: "dri", by: "赵磊" });
  });

  it("issue_statement 为空：一条议题都不建", async () => {
    const before = (await api.listIssues()).length;
    for (const out of [{ issue_statement: "   " }, { issue_statement: 42 }, {}]) {
      const r = applyA1aInbox(wrote(out), crawled());
      expect(r.issueId).toBeUndefined();
      expect(r.applied).toContain("没有议题正文");
    }
    // 建一条没有标题的议题等于在池子里放一条编的。
    expect((await api.listIssues()).length).toBe(before);
  });

  it("ignore：不建议题，也不去标注一张不存在的卡", async () => {
    const before = (await api.listIssues()).length;
    const r = applyA1aInbox(base({}), crawled());
    expect(r.issueId).toBeUndefined();
    expect(r.applied).toContain("不值得");
    expect((await api.listIssues()).length).toBe(before);
  });

  it("failed：不建任何议题", async () => {
    const before = (await api.listIssues()).length;
    const r = applyA1aInbox(base({ status: "failed", route: undefined }), crawled());
    expect(r.issueId).toBeUndefined();
    expect((await api.listIssues()).length).toBe(before);
  });

  it("cited_member_ids 指向库里没有的 id：strategyRef.id 是空串，不是那个编出来的编号", async () => {
    const r = applyA1aInbox(
      wrote({ issue_statement: "这条变化一旦成立，谁必须重新考虑自己在做什么？", cited_member_ids: ["JDG-不存在"] }),
      crawled()
    );
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    expect(card?.strategyRef.id).toBe("");
    // 指向不存在对象的编号会让「影响哪条判断」永远点不开。
    const issue = await api.getIssue(r.issueId!);
    expect(issue.judgmentRefs).toEqual([]);
  });

  it("同一条信号连点两次：只有一条议题，第二次原样把那一条还回来", async () => {
    const sig = crawled();
    const first = applyA1aInbox(wrote({ issue_statement: "连点两次也只该有一条议题？" }), sig);
    expect(first.issueId).toBeTruthy();

    // route 记完 judged 之后的样子 —— 第二次点进来读到的就是它。
    const after = { ...sig, judged: { runId: "RUN-A1a-x", status: "ok", at: "x", issueId: first.issueId } };
    const count = (await api.listIssues()).length;
    const second = applyA1aInbox(wrote({ issue_statement: "连点两次也只该有一条议题？" }), after as InboxSignal);
    expect(second.issueId).toBe(first.issueId);
    /*
     * 第二次**不新建**，这一条没变。变的是它此刻干什么：议题已经在了，这一轮就把正文
     * 补到那一条上（`patchSignalIssueFraming`）—— 一号位在待挑页确认升级那条路走的
     * 就是这一支：议题当场建好、A1a 随后只负责写四块框架。
     */
    expect(second.applied).toContain(first.issueId!);
    expect((await api.listIssues()).length).toBe(count);
  });

  it("update_issue：新议题照样建出来，被取代的那条一个字没动", async () => {
    const old = await api.addIssue("旧的说法：入口还在能力侧");
    const r = applyA1aInbox(
      wrote({ issue_statement: "新的说法把范围收窄到一个行业，还成立吗？", target_issue_code: old.id }, "update_issue"),
      crawled()
    );
    expect(r.issueId).toBeTruthy();
    expect(r.issueId).not.toBe(old.id);

    // 取代成不成立是一号位采信那一下的事，立案这一下不碰旧议题。
    const stillOld = await api.getIssue(old.id);
    expect(stillOld.state).toBe(old.state);
    expect(stillOld.updatedAt).toBe(old.updatedAt);
  });

  it("同一条信号第二次跑出 ignore：返回的 issueId 还是第一次那条，议题条数不变", async () => {
    const sig = crawled();
    // 第一次跑出 new_issue，开出议题。
    const first = applyA1aInbox(wrote({ issue_statement: "第二次判为噪音也不抹掉第一次开的议题？" }), sig);
    expect(first.issueId).toBeTruthy();

    // route 记完 judged 之后的样子 —— 第二次点进来读到的就是它。
    const after = { ...sig, judged: { runId: "RUN-A1a-y", status: "ok", at: "y", issueId: first.issueId } };
    const count = (await api.listIssues()).length;

    // 第二次跑出 ignore —— 重复闸会把第一次的 issueId 原样还回来。
    const second = applyA1aInbox(base({}), after as InboxSignal);
    expect(second.issueId).toBe(first.issueId);
    expect(second.applied).toContain("没有重开");
    expect((await api.listIssues()).length).toBe(count);
  });

  it("reported + shakes 是真有的判断 id：strategyRef.id 等于它，judgmentRefs 也有", async () => {
    // 拿一条真的判断 id（种子里确实存在的那条「04-J1」）。
    const realJudgmentId = "04-J1";
    const r = applyA1aInbox(
      wrote({ issue_statement: "人答的那条判断排在模型前面？" }),
      reported({ shakes: realJudgmentId })
    );
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    expect(card?.strategyRef.id).toBe(realJudgmentId);
    // statement 应该是那条判断的原话，不是空锚点那句话。
    expect(card?.strategyRef.statement).not.toContain("图谱里没有它的锚点");

    const issue = await api.getIssue(r.issueId!);
    expect(issue.judgmentRefs).toEqual([realJudgmentId]);
  });

  it("reported + shakes 给一个库里根本没有的 id：回落到空锚点", async () => {
    const r = applyA1aInbox(
      wrote({ issue_statement: "人答错了，库里没有这个判断？" }),
      reported({ shakes: "99-J999" })
    );
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    expect(card?.strategyRef.id).toBe("");
    expect(card?.strategyRef.statement).toContain("图谱里没有它的锚点");

    const issue = await api.getIssue(r.issueId!);
    expect(issue.judgmentRefs).toEqual([]);
  });

  it("shakes 有真判断 + cited_member_ids 也有：用的是 shakes 那条", async () => {
    // 种子里 seed-agent-domain 有两条判断：04-J1 和 04-J2
    const realJudgmentId1 = "04-J1";
    const realJudgmentId2 = "04-J2";

    const r = applyA1aInbox(
      wrote({
        issue_statement: "人答的 shakes 排在模型的 cited_member_ids 前面？",
        cited_member_ids: [realJudgmentId2],
      }),
      reported({ shakes: realJudgmentId1 })
    );
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    // 用的应该是 shakes 那条（04-J1），而不是 cited_member_ids 那条（04-J2）。
    expect(card?.strategyRef.id).toBe(realJudgmentId1);

    const issue = await api.getIssue(r.issueId!);
    expect(issue.judgmentRefs).toEqual([realJudgmentId1]);
  });

  it("reported + shakes 指向真判断：卡的 domainIds 接到那条判断的域", async () => {
    const realJudgmentId = "04-J1";
    // 从库里取那条判断的域 —— 断言的是「等于那条判断的域」，不是硬编码的域 id。
    const detail = await api.getJudgment(realJudgmentId);
    expect(detail.judgment.domainId).toBeTruthy();

    const r = applyA1aInbox(
      wrote({ issue_statement: "议题动摇哪条判断 → 判断属于哪个域？" }),
      reported({ shakes: realJudgmentId })
    );
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    // 卡的 domainIds 应该正好等于那条判断的域（一个元素的数组）。
    expect(card).toBeTruthy();
    expect(card!.domainIds).toEqual([detail.judgment.domainId]);
  });

  it("reported + shakes 指向库里不存在的判断：卡的 domainIds 是空数组", async () => {
    const r = applyA1aInbox(
      wrote({ issue_statement: "一条判断都锚不上时才是诚实的空？" }),
      reported({ shakes: "99-J999" })
    );
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    // 接不出来就留空 —— 这条是闸，保证「接不出来」不会被改成瞎猜一个。
    expect(card).toBeTruthy();
    expect(card!.domainIds).toEqual([]);
  });

  it("reported + shakes 指向真判断，处置后议题的 domainId 也接上了", async () => {
    const realJudgmentId = "04-J1";
    const detail = await api.getJudgment(realJudgmentId);
    expect(detail.judgment.domainId).toBeTruthy();

    const r = applyA1aInbox(
      wrote({ issue_statement: "处置那一刻归域：从卡的 domainIds 取？" }),
      reported({ shakes: realJudgmentId })
    );
    const card = (await api.listPending()).find((c) => c.issueId === r.issueId);
    expect(card).toBeTruthy();

    // 处置这张卡（用 watch 而不是 discuss —— discuss 会开跑深度研究）。
    const issue = await api.disposeCard(card!.id, "watch");
    // 议题的 domainId 应该等于同一个域。
    expect(issue.domainId).toBe(detail.judgment.domainId);
  });
});
