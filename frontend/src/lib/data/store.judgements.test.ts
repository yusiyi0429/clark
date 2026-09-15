// 这两行必须在**任何会摸到 store.ts 的 import 之前**生效，而写在文件顶上不够：
// ESM 的 import 会被提到模块最前面求值，所以静态 import 一律排在这两行赋值之前。
// 这个文件曾经在这里栽过 —— `applyA1aInbox` 那一行原来是静态 import，它 import 了
// `@/lib/data/store`，于是 store.ts 在这两行跑到之前就求值完了，loadSnapshot 把开发机
// `.data/store.json` 里的现场数据装了进来：下面几条「种子里这条判断是干净的」前置断言
// 跟着那个 gitignore 掉的文件飘（现场数据里它早被晃过了）。
// 所以下面所有会到 store 的模块都在 beforeAll 里 await import，不留静态 import。
//
// TKOS_PERSIST=0：别读也别写 .data 里那份真快照。
process.env.TKOS_PERSIST = "0";
// TKOS_MODEL_MOCK=1：单测里一次模型都不许真调用（addIssue、issueFromSignal 都会起预研），
// 而这台机器上可能导出着真 key。那一轮在假模型下会就地失败，与这几条断言无关。
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 判断板的空态：**空板不许说自己正在读。**
 *
 * 报告读成判断这一步是自动的（深研跑完就起一轮 A5，读板时也会顺手结算一次），
 * 所以「板是空的」有三种完全不同的原因：报告还没到、正在读、读挂了。屏幕上分不出来
 * 的话，一号位盯着一块空板，而它答不出自己什么时候会不空 —— 这是 `pending` 这一栏
 * 存在的全部理由。
 *
 * 这里钉住最容易坏的那一头：**手上没有报告的时候，读一次板既不许说「正在读」，
 * 也不许真起一轮模型调用。** 反过来那头（有报告 → 起一轮）要真跑模型才验得到，
 * 不在这一层。
 *
 * 只碰数据层：`store.ts` 在进程内现算。没有 `TKOS_MODE` 就是 live（见 `mode.ts`），
 * 正是这条断言要的那一档 —— demo 那一档 `pending` 恒为 null，测不出东西。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";
import type { AgentRunRecord, InboxSignal } from "./types";
import type { applyA1aInbox as ApplyA1aInbox } from "../agent/a1a/apply";

let api: typeof Api;
let applyA1aInbox: typeof ApplyA1aInbox;

beforeAll(async () => {
  api = (await import("./store")).api;
  applyA1aInbox = (await import("../agent/a1a/apply")).applyA1aInbox;
});

// 共用辅助函数：构造一个 A1a 的运行记录（new_issue 路由）
const makeRunNew = (id: string, out: Record<string, unknown>): AgentRunRecord =>
  ({
    id,
    agent: "A1a",
    status: "ok",
    route: "new_issue",
    output: out,
    input: "",
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
  }) as AgentRunRecord;

// 共用辅助函数：构造一个人报的信号
const makeReported = (dedupeKey: string, shakes: string): InboxSignal =>
  ({
    kind: "reported",
    by: "张三",
    dedupeKey,
    title: "测试信号",
    url: "",
    text: "测试信号正文",
    publishedAt: "",
    source: "内部",
    why: "测试",
    receivedAt: "2026-08-18T01:00:00.000Z",
    shakes,
  }) as InboxSignal;

/*
 * 共用辅助函数：把一条议题定下来（走真 `confirmClosure`）。
 *
 * 下面两条用例都要靠它去触发 `clearShakenBy`，装配只留一份。
 *
 * `route` 写死 `"close"`：`"strategy"` 那一档会把 standing 改成 confirmed，
 * 正好盖掉这两条用例要断言的那次回落。草案要先塞进去 —— 产品里它由 A10 写出来，
 * 而单测里一次模型调用都不许打（见文件头）。
 */
const closeIssue = async (issueId: string, choose: string): Promise<void> => {
  const fields = {
    choose,
    notChoose: "",
    why: "",
    keyHypothesis: "",
    riskAccepted: "",
    commitment: "",
    reopenTrigger: "",
  };
  const { __seedClosureDraftForTest } = await import("./store");
  __seedClosureDraftForTest(issueId, {
    issueId,
    sourceMeetingId: "",
    // 没上会（`sourceMeetingId` 空）就没有「散会」这一刻，所以是 null 不是 0。
    minutesSinceMeeting: null,
    fields,
    writeBack: null,
    revises: [],
    pastMedianLabel: null,
  });
  await api.confirmClosure(issueId, fields, "close");
};

describe("判断板的空态", () => {
  it("没有深研报告：板空、pending 是 null、一轮模型都没起", async () => {
    const issue = await api.addIssue("要不要把授权这件事做成一条产品原则");

    const board = await api.getBoard(issue.id);
    expect(board.draft).toEqual([]);
    expect(board.confirmed).toEqual([]);
    // null 才对。写 "running" 就是许下一个不会到来的承诺 —— 板上的轮询会一直转。
    expect(board.pending).toBeNull();

    // 顺手结算那一下不许在没有报告时起任务：起了就是一次白花的模型调用。
    expect((await api.judgementsStatus(issue.id)).status).toBe("idle");
  });

  it("读两次板不会把状态读出花来 —— 这一块是会被轮询反复读的", async () => {
    const issue = await api.addIssue("客户到底卡在授权还是卡在效果");
    await api.getBoard(issue.id);
    expect((await api.getBoard(issue.id)).pending).toBeNull();
    expect((await api.judgementsStatus(issue.id)).status).toBe("idle");
  });
});

/**
 * 运行期建出来的议题也回填 judgment.shakenBy。
 *
 * 这条回路在上线第一天就是必需的：潜在议题现在是空屏起步（种子里一条议题都没有），
 * 所有议题都由运行期建出来。如果这条回填不生效，卡面写着「动摇 04-J1」，而 04-J1
 * 自己那一页说没有任何议题在晃它 —— 同一件事在两页上自相矛盾。
 */
describe("运行期建议题时回填 judgment.shakenBy", () => {
  it("issueFromSignal 建议题 + 指向真判断：那条判断的 shakenBy 包含新议题 id，standing 提升为 shaking", async () => {
    const judgmentId = "04-J1";
    // 前置条件：种子里 04-J1 的 standing 是 unverified、shakenBy 是空数组
    const before = await api.getJudgment(judgmentId);
    expect(before.judgment.standing).toBe("unverified");
    expect(before.judgment.shakenBy).toEqual([]);

    // 通过 applyA1aInbox 走 issueFromSignal 建议题
    const r = applyA1aInbox(
      makeRunNew("RUN-test", { issue_statement: "运行期建的议题也能晃判断吗？" }),
      makeReported(`dri-${Math.random()}`, judgmentId)
    );
    expect(r.issueId).toBeTruthy();

    // 断言判断的 shakenBy 包含新议题，standing 变成 shaking
    const after = await api.getJudgment(judgmentId);
    expect(after.judgment.shakenBy).toEqual([r.issueId]);
    expect(after.judgment.standing).toBe("shaking");
  });

  it("同一条议题指向同一条判断多次：shakenBy 里那个 id 只出现一次", async () => {
    const judgmentId = "04-J2";
    // 第一次建议题
    const r1 = applyA1aInbox(
      makeRunNew("RUN-test", { issue_statement: "第一条议题" }),
      makeReported(`dri-${Math.random()}`, judgmentId)
    );
    const after1 = await api.getJudgment(judgmentId);
    const count1 = after1.judgment.shakenBy.filter((id: string) => id === r1.issueId).length;
    expect(count1).toBe(1);

    // 创建第二条议题，也指向同一条判断
    const r2 = applyA1aInbox(
      makeRunNew("RUN-test", { issue_statement: "第二条议题" }),
      makeReported(`dri-${Math.random()}`, judgmentId)
    );
    const after2 = await api.getJudgment(judgmentId);
    // 每个 id 应该只出现一次
    const uniqueIds = new Set(after2.judgment.shakenBy);
    expect(after2.judgment.shakenBy.length).toBe(uniqueIds.size);
    expect(after2.judgment.shakenBy).toContain(r1.issueId);
    expect(after2.judgment.shakenBy).toContain(r2.issueId);
  });

  // 用例 3（「standing 本来不是 unverified：提级不发生」）已删除。
  // 原因：种子里 37 条判断的 standing 全是 unverified，任务书要的「种子里找一条
  // 真的非 unverified 的」挑不出来。显式构造反例需要直接修改 store.judgments，
  // 但 store 对象未 export、api.getJudgment() 返回的是 clone —— 测试无法在不修改
  // store.ts 的前提下访问到原始对象。而评审明确要求「不要碰 src/lib/data/store.ts」。
  // 「confirmed 的判断不会被降级成 shaking」这条约束在今天的测试基础设施下测不了。
});

/**
 * 最后一个晃它的议题定完之后，「动摇中」得下得来。
 *
 * clearShakenBy 在议题定下来后把它从 judgment.shakenBy 里摘掉，但之前不动 standing。
 * 于是最后一个议题定完后，那条判断永远停在 shaking：StandingTag 永远写「动摇中」，
 * standingSentence 会说出「<id> 正在动摇，0 个议题在晃它。」—— 自相矛盾。
 *
 * 修复：摘掉之后，standing === "shaking" 且 shakenBy.length === 0 → 回落到 unverified。
 * 理由：提级只从 unverified 出发，所以 shaking 这个状态的来路只有一条，回落到来处
 * 是唯一说得通的对称。
 */
/**
 * 挑一条**此刻没有任何议题在晃**的判断。
 *
 * 这两条用例要的前置条件是「shakenBy 是空的」—— 只有这样，把自己造的那一条摘掉之后
 * 才真的是「最后一个」。原来是写死 `01-J3` / `01-J4`，靠的是「live 档起来时库里一件
 * 议题都没有」这个前提；预载案例进来之后那个前提没了（真的有议题在晃 01-J3），于是
 * 两条用例红在**前置条件**上，而它们要验的那个行为一点没坏。
 *
 * 所以改成现挑：从这个域的判断里找第一条干净的。找不到就明确失败 —— 悄悄跳过等于
 * 让这两条用例从此不再验任何东西。
 */
const pristineJudgment = async (candidates: string[]): Promise<string> => {
  for (const id of candidates) {
    const d = await api.getJudgment(id).catch(() => null);
    if (d && d.judgment.shakenBy.length === 0 && d.judgment.standing === "unverified") return id;
  }
  throw new Error(
    `这几条判断此刻都有议题在晃或者不是 unverified（${candidates.join("、")}）——` +
      "这两条用例要的是一条干净的判断，换几条再试。",
  );
};

describe("动摇中的判断在最后一个议题定完后能回落到未验证", () => {
  it("一条 shaking 的判断，把最后一个晃它的议题摘掉 → standing 回到 unverified，verifiedByTasks 不变", async () => {
    // 原来这几条候选是 01-J*，那一批 2026-08-31 随 01 域一起去掉了。现在库里在版的
    // 只剩 Method 那一个域的八条（03-J1…03-J8）。
    const judgmentId = await pristineJudgment(["03-J1", "03-J2", "03-J3", "03-J4", "03-J7", "03-J8"]);
    // 前置条件：这一条此刻是 unverified、没有任何议题在晃它（`pristineJudgment` 保证）。
    const before = await api.getJudgment(judgmentId);
    const verifiedTasksBefore = before.judgment.verifiedByTasks;

    // 通过 applyA1aInbox 走 issueFromSignal 建议题，让判断变成 shaking
    const r = applyA1aInbox(
      makeRunNew("RUN-test-clear", { issue_statement: "这条议题会晃 01-J3" }),
      makeReported(`dri-clear-${Math.random()}`, judgmentId)
    );
    expect(r.issueId).toBeTruthy();
    const issueId = r.issueId!;

    // 断言判断的 shakenBy 包含新议题，standing 变成 shaking
    const afterShake = await api.getJudgment(judgmentId);
    expect(afterShake.judgment.shakenBy).toEqual([issueId]);
    expect(afterShake.judgment.standing).toBe("shaking");

    // 定下这条议题：真路径会调 clearShakenBy
    await closeIssue(issueId, "关闭这条议题");

    // 断言：standing 回落到 unverified，shakenBy 里那个议题被摘掉，verifiedByTasks 不变
    const afterClear = await api.getJudgment(judgmentId);
    expect(afterClear.judgment.standing).toBe("unverified");
    expect(afterClear.judgment.shakenBy).toEqual([]);
    expect(afterClear.judgment.verifiedByTasks).toEqual(verifiedTasksBefore);
  });

  it("同一条判断上挂着两个议题，只摘掉一个 → standing 仍是 shaking", async () => {
    const judgmentId = await pristineJudgment(["03-J2", "03-J3", "03-J4", "03-J7", "03-J8"]);
    // 前置条件同上。
    await api.getJudgment(judgmentId);

    // 创建第一条议题
    const r1 = applyA1aInbox(
      makeRunNew("RUN-test-clear", { issue_statement: "第一条议题晃 01-J4" }),
      makeReported(`dri-clear-${Math.random()}`, judgmentId)
    );
    expect(r1.issueId).toBeTruthy();
    const issueId1 = r1.issueId!;

    // 创建第二条议题
    const r2 = applyA1aInbox(
      makeRunNew("RUN-test-clear", { issue_statement: "第二条议题也晃 01-J4" }),
      makeReported(`dri-clear-${Math.random()}`, judgmentId)
    );
    expect(r2.issueId).toBeTruthy();
    const issueId2 = r2.issueId!;

    // 断言：两个议题都在 shakenBy 里，standing 是 shaking
    const afterBoth = await api.getJudgment(judgmentId);
    expect(afterBoth.judgment.shakenBy).toContain(issueId1);
    expect(afterBoth.judgment.shakenBy).toContain(issueId2);
    expect(afterBoth.judgment.standing).toBe("shaking");

    // 只定下第一条议题
    await closeIssue(issueId1, "关闭第一条议题");

    // 断言：standing 仍是 shaking（因为还有第二个议题在晃它），shakenBy 只剩第二个
    const afterClearOne = await api.getJudgment(judgmentId);
    expect(afterClearOne.judgment.standing).toBe("shaking");
    expect(afterClearOne.judgment.shakenBy).toEqual([issueId2]);
  });
});

/**
 * 议题去向记录的排序口径：按真实时刻倒序，不依赖时间戳格式统一。
 *
 * 字符串比较只在「全表同一种偏移量」这个不变量成立时才对，而这条不变量
 * 刚刚被破过一次（A3 预研那条事件的时间戳是 Z 格式）。现在改用 Date.parse
 * 比较，即使格式不同也能按真实时刻正确排序。
 */
describe("议题去向记录的排序口径", () => {
  it("compareIssueLogByTime 按时刻倒序，而不是字符串顺序", async () => {
    const { compareIssueLogByTime } = await import("./store");

    // 两条时间戳：A 的字符串更大，但 B 的真实时刻更晚
    const A = { at: "2026-08-20T20:00:00+08:00" }; // 真实时刻 = 12:00Z
    const B = { at: "2026-08-20T16:00:00Z" }; // 真实时刻 = 16:00Z，比 A 晚

    // 前提：字符串比较会把 A 排在前面（"20..." > "16..."）
    expect("2026-08-20T20:00:00+08:00".localeCompare("2026-08-20T16:00:00Z")).toBeGreaterThan(0);

    // 断言：compareIssueLogByTime 按真实时刻倒序，B 在前
    const sorted = [A, B].sort(compareIssueLogByTime);
    expect(sorted).toEqual([B, A]);
  });

  /*
   * 同一个事件 id 在账上只留一条。
   *
   * 固定后缀的事件 id（`-talk`、`-writeback-draft` 这些）就是「这件事只发生一次」这个
   * 声明本身，而它们背后那一步是可以重来的。记出两条同 id 的行，`Timeline` 那一侧
   * 就是两个相同的 React key（它用 `key={event.id}`），更新时哪一行留在屏幕上不定；
   * 而一份声称「每一步都在这儿」的账被同一句话灌满之后，真正发生过的几步反而找不着。
   *
   * 拿对谈当探针：`openAdvisorTurn` 只记他说的那一句，一次模型都不调，所以两轮聊
   * 完之后账上有几条对谈事件，是这条不变量在这一层唯一验得到的地方。
   */
  it("聊两轮：账上只有一条对谈事件，轮次数到 2", async () => {
    const issue = await api.addIssue("要不要把这条口径写进交付文档");
    await api.openAdvisorTurn(issue.id, "先说说这件事卡在哪");
    await api.openAdvisorTurn(issue.id, "那我们手上有什么");

    const talks = (await api.getTimeline(issue.id)).filter((e) => e.kind === "talk");
    expect(talks).toHaveLength(1);
    expect(talks[0].headline).toBe("议题研究对谈 2 轮");
  });
});
