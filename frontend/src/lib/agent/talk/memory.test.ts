/**
 * 决策记忆与用户卡的测试。
 *
 * **整个文件跑 demo 那一档** —— 环境变量设在文件最上方（必须在任何碰到 store.ts 的
 * import 之前）。纪律：上面所有静态 import 必须是 `import type` 或本身不碰 store。
 */

// 环境变量必须在任何碰到 store.ts 的 import 之前设好
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";
process.env.TKOS_MODE = "demo";

import { beforeAll, describe, expect, it } from "vitest";
import type { DecisionMemory, UserCard } from "./memory";
// checkCardItem 等纯函数不碰 store，可以直接导入
import { checkCardItem, hitOverturn, overturn, packUserCard, pickDecisionMemories } from "./memory";

const mem = (id: string, judgment: string, conditions: string[], tags: string[]): DecisionMemory => ({
  id,
  judgment,
  rationale: "见当次 session 的证据台账",
  overturnConditions: conditions,
  issueTags: tags,
  sessionId: "S1",
  confirmedAt: "2026-08-20T00:00:00.000Z",
  status: "active",
});

const mems: DecisionMemory[] = [
  mem("M-面板", "面板这一轮不扩产", ["前三家合计份额跌破 50%"], ["面板", "产能"]),
  mem("M-产能", "产能爬坡按 18 个月算", ["新线量产周期短于 12 个月"], ["产能"]),
  mem("M-口径", "份额按出货面积算，不按片数", ["行业统计改用片数口径"], ["面板", "口径"]),
  mem("M-无关", "海外仓不自建", ["三方仓履约时效跌破两日达"], ["物流"]),
];

// 只给 hitOverturn 用得到的两栏（见它的签名注释）。claim 里逐字含着 M-面板 那条推翻条件。
const evShareBelow50 = { id: "E7", claim: "2026 上半年前三家合计份额跌破 50%，为 48.3%" };

const bigCard: UserCard = {
  challengeDimensions: [
    { dimension: "统计口径混用", count: 9, sessions: ["S1", "S2", "S3"] },
    { dimension: "样本区间选择", count: 6, sessions: ["S1", "S4"] },
    { dimension: "同比与环比混说", count: 4, sessions: ["S2"] },
    ...Array.from({ length: 30 }, (_, i) => ({ dimension: `边角维度${i}`, count: 1, sessions: ["S9"] })),
  ],
  longTermViews: Array.from({ length: 20 }, (_, i) => ({
    view: `长期论点${i}`,
    firstSeen: "2026-01-01",
    recentChange: "无",
  })),
  preferences: { granularity: "要机制不要罗列", riskStance: "先说下行", expression: "结论前置" },
  revisitHabit: "只说编号不说原话",
};

describe("用户卡那条红线", () => {
  it("命中立场关键词的条目一律拒 —— 用户卡不许成为结论的引力方向", () => {
    for (const bad of [
      { dimension: "他倾向于看空面板，回答要顺着", count: 3, sessions: [] },
      { view: "他希望结论是别扩产", firstSeen: "", recentChange: "" },
      // 两类共用同一张关键词表：上一版「结论是」只挡 view、「要顺着」只挡 dimension，
      // 于是同一句话换个字段名就漏得过去
      { dimension: "他希望结论是别扩产", count: 3, sessions: [] },
      { view: "他倾向于看空面板，回答要顺着", firstSeen: "", recentChange: "" },
    ]) expect(checkCardItem(bad).ok).toBe(false);
  });

  it("绕开关键词的立场条目它挡不住 —— 这一层是前置过滤器，不是语义判断器", () => {
    // 注释与标题都不许说它「一律拒」：这一句同样是立场，从这里直接放行，
    // 另一半由 system prompt §3 第 7 条兜。写成测试是为了让谁改宽了口径也不至于
    // 以为自己修好了一个 bug —— 这是已知的、写在注释里的漏法。
    expect(checkCardItem({ view: "面板价格明年见底", firstSeen: "", recentChange: "" }).ok).toBe(true);
  });

  it("挑战维度与表达偏好照收 —— 这两件才是它的用途", () => {
    expect(checkCardItem({ dimension: "统计口径混用", count: 3, sessions: ["S1"] }).ok).toBe(true);
    expect(checkCardItem({ granularity: "要机制不要罗列" }).ok).toBe(true);
  });

  it("压缩版有上限，砍掉的是最不常出现的那些 —— 出现次数最高的三条必须还在", () => {
    const packed = packUserCard(bigCard);
    // 真上限是 `packUserCard` 里的 `MAX_CHARS = 400`（≈500 token 的中文字符代理）。
    // 上一版这里写 1500，比真上限宽三倍多 —— 那个数字钉不住任何东西。
    expect(packed.length).toBeLessThanOrEqual(400);
    expect(packed.length).toBeGreaterThan(60);         // 返回空串也绿的那个洞：补下界
    expect(packed).toContain("统计口径混用");
    expect(packed).toContain("样本区间选择");
    expect(packed).toContain("同比与环比混说");
    expect(packed).toContain("要机制不要罗列");        // 偏好三栏不参与砍
    expect(packed).not.toContain("边角维度29");        // 出现一次的那些确实被砍了
  });

  it("偏好长到一条维度都装不下时，不留一个空的「常挑战维度：」表头", () => {
    const wordy: UserCard = {
      challengeDimensions: [{ dimension: "统计口径混用", count: 9, sessions: ["S1"] }],
      longTermViews: [],
      // 偏好三栏不参与砍且排在前面，长到吃光预算时后面那块就一行都装不进
      preferences: {
        granularity: "要机制不要罗列".repeat(30),
        riskStance: "先说下行".repeat(20),
        expression: "结论前置".repeat(20),
      },
    };
    const packed = packUserCard(wordy);
    /*
     * **先钉正向的那一半。** 上一版这条只有两句 `not.toContain` —— 于是
     * `packUserCard` 返回空串照样全绿，而那正好是最坏的实现：规格说不参与砍的偏好三栏
     * 会一起没了。实测：`memory.ts` 里 `packUserCard` 开头加一句
     * `if (card.preferences.granularity.length > 50) return "";`
     * → memory + prefix 共 27 条全绿。
     */
    expect(packed).toContain("粒度偏好：");
    expect(packed).toContain("风险立场偏好：");
    expect(packed).toContain("表达偏好：");
    // 偏好三栏是一起带上的，长度下界按它们三条拼出来的字数走
    const prefChars =
      wordy.preferences.granularity!.length +
      wordy.preferences.riskStance!.length +
      wordy.preferences.expression!.length;
    expect(packed.length).toBeGreaterThan(prefChars);

    expect(packed).not.toContain("统计口径混用");   // 确实一条都没装下
    expect(packed).not.toContain("常挑战维度：");   // 所以表头也不许出现
  });
});

describe("决策记忆", () => {
  it("按议题相似度取 top-k，不相干的不进前缀", () => {
    const r = pickDecisionMemories(mems, ["面板", "产能"], 3);
    expect(r).toHaveLength(3);
    expect(r.map((m) => m.id)).not.toContain("M-无关");
  });

  it("一条标签都不重的，k 还有余量也不进 —— 前缀里塞不相干的判断比少塞几条更坏", () => {
    expect(pickDecisionMemories(mems, ["物流"], 3).map((m) => m.id)).toEqual(["M-无关"]);
  });

  it("新证据命中某条推翻条件 → 连命中提示一起注入", () => {
    const h = hitOverturn(mems, [evShareBelow50]);
    expect(h).toHaveLength(1);
    expect(h[0].memoryId).toBe("M-面板");
    expect(h[0].condition).toContain("跌破 50%");
  });

  it("一条都没命中时是空数组，不是「命中了但条件是空串」", () => {
    expect(hitOverturn(mems, [{ id: "E8", claim: "面板价格环比持平" }])).toEqual([]);
  });

  it("两条证据说的是同一件事时只回一条 —— 前缀里同一行警告不许印两遍", () => {
    const h = hitOverturn(mems, [
      evShareBelow50,
      { id: "E9", claim: "另一家机构也算出前三家合计份额跌破 50%" },
    ]);
    expect(h).toEqual([{ memoryId: "M-面板", condition: "前三家合计份额跌破 50%" }]);
  });

  it("被推翻的记忆链到推翻它的那条，不删", () => {
    const after = overturn(mems, "M-面板", "M-面板-v2");
    expect(after).toHaveLength(mems.length);                     // 不删
    const one = after.find((m) => m.id === "M-面板")!;
    expect(one.status).toBe("overturned");
    expect(one.overturnedBy).toBe("M-面板-v2");
    expect(mems[0].status).toBe("active");                       // 原数组没被原地改
    // 不删 ≠ 还进前缀：被推翻的那条不再当成当前判断递给模型
    expect(pickDecisionMemories(after, ["面板", "产能"], 3).map((m) => m.id)).not.toContain("M-面板");
  });
});

describe("走真库的接线覆盖（裁定 6）", () => {
  let api: typeof import("@/lib/data/store").api;
  let getDecisionMemories: typeof import("@/lib/data/store").__getDecisionMemoriesForTest;
  let setUserCard: typeof import("@/lib/data/store").__setUserCardForTest;

  beforeAll(async () => {
    /*
     * `TKOS_MODE=demo`：live 那一档 `store.issues` 是空的，而下面每一条都要一件
     * **在动摇某条在版判断**的议题 —— 那样的议题只有内容包里有。
     */
    ({
      api,
      __getDecisionMemoriesForTest: getDecisionMemories,
      __setUserCardForTest: setUserCard,
    } = await import("@/lib/data/store"));
  });

  /**
   * 第 n 件真在动摇某条在版判断的议题。照 land.test.ts 的 shakingIssue 写法。
   *
   * **每条用例各占一件**（0/1/2/3），因为 `confirmCandidate` 对同一条候选只肯确认一次。
   * 各占一件之后每条用例都自己写得出自己要查的那条记忆，不必依赖上一条跑过。
   */
  const shakingIssue = async (n = 0) => {
    let seen = 0;
    for (const s of await api.listIssues()) {
      const issue = await api.getIssue(s.id);
      if (issue.judgmentRefs.length === 0) continue;
      if (seen === n) return issue;
      seen++;
    }
    throw new Error(`种子里没有第 ${n + 1} 件在动摇在版判断的议题 —— 这条测试的前提变了`);
  };

  type Candidate = {
    statement: string;
    basis: string;
    boundary: string;
    reopenIf: string;
  };

  const CANDIDATE: Candidate = {
    statement: "面板这一轮不扩产",
    basis: "口径换算之后份额还在 52%",
    boundary: "这个判断只说产能，不说价格",
    reopenIf: "行业统计改用片数口径",
  };

  /**
   * 走完「聊定 → 落地 → 他按下确认」这一整条，返回新写进库的那条决策记忆。
   *
   * 这一段是每条用例的自给自足的起点：记忆在产品里只有这一条路写得出来
   * （`confirmCandidate`，模型走不到），所以不能像纯函数那样拿夹具喂。
   */
  const confirmOn = async (issueId: string, candidate: Candidate, extraArms: string[] = []) => {
    await api.proposeTalkPoint(issueId, {
      thesis: candidate.statement,
      statements: [candidate.basis],
      openQuestions: ["片数口径的换算系数是不是全行业一致"],
      candidate,
    });
    const landing = await api.landTalkCandidate(issueId, extraArms);
    expect(landing.nodeId).not.toBeNull();
    await api.confirmCandidate(issueId, landing.nodeId!);
    const all = getDecisionMemories();
    return all[all.length - 1];
  };

  it("确认时写决策记忆：条件等于 ProbeNode.arms，凭什么取的是板上那一条真写着的话", async () => {
    const issue = await shakingIssue(0);
    const before = getDecisionMemories().length;

    const memory = await confirmOn(issue.id, CANDIDATE, ["前三家合计份额跌破 50%"]);

    // 验收标准：删掉 confirmCandidate 里的 store.decisionMemories.push(...) → 这条断言会红
    expect(getDecisionMemories().length).toBe(before + 1);

    expect(memory.id).toMatch(/^DM-/);
    expect(memory.judgment).toBe(CANDIDATE.statement);
    expect(memory.overturnConditions).toEqual([
      CANDIDATE.reopenIf,
      "前三家合计份额跌破 50%",
    ]);
    expect(memory.issueTags).toContain(issue.domainId);
    expect(memory.issueTags).toContain(issue.judgmentRefs[0]);
    expect(memory.status).toBe("active");
    expect(memory.confirmedAt).toBeTruthy();
    expect(memory.sessionId).toBe(issue.id); // sessionId 填的是 issueId

    /*
     * 「凭什么」必须是板上那一条真写着的话，不是一句指路的套话。他还没在板上单独按过
     * 这一条，所以这里取到的是 `basis`（参谋凭什么这么写）；他按过之后取的是
     * `confirmed.support`（他自己为什么点头）。退回指针那一档等于这一栏没有信息，
     * 而「答得出当初为什么那么判」正是决策记忆存在的全部理由。
     */
    expect(memory.rationale).toBe(CANDIDATE.basis);
    expect(memory.rationale).not.toContain("回写记录");
  });

  it("装配时取到相关记忆 —— 断言的是只有记忆块才印得出的那两行", async () => {
    const issue = await shakingIssue(1);
    const memory = await confirmOn(issue.id, {
      statement: "产能爬坡按 18 个月算",
      basis: "上一条新线从通线到满产用了 17 个月",
      boundary: "这个判断只说自建线，不说代工",
      reopenIf: "新线量产周期短于 12 个月",
    });

    const contextWithMemory = await api.advisorContext(issue.id);
    expect(contextWithMemory).toContain("相关决策记忆");

    /*
     * **不许断言 `memory.judgment`**：那句话在同一份上下文里本来就有 —— 判断板那一块
     * 里落上去的就是它。上一版这里断言的正是它，于是把整个记忆段删掉这条照旧绿。
     *
     * 记忆块那两行的辨识特征是**行首的两个空格**：判断板那块的同名两栏挂在编号后面
     * （`  ①：凭什么：…；什么新证据会把它重新打开：…`），行首对不上。
     */
    expect(contextWithMemory).toContain(`\n  凭什么：${memory.rationale}`);
    expect(contextWithMemory).toContain(
      `\n  什么新证据会把它重新打开：${memory.overturnConditions.join("；")}`
    );

    /*
     * **板那一块的同名两栏也在这同一份上下文里**，措辞必须和记忆那一段一字不差 ——
     * 两段进的是同一次模型调用（先 push 板、再 push 记忆），同一件事有两个说法时，
     * 模型只会理解成两件事。两边现在引的是 `prefix.ts` 的同一对常量。
     *
     * 这里用**字面**断言，不引那两个常量：引常量的话，把板那一块换回另一套自己的措辞
     * 照旧全绿 —— 而这条测试要钉的恰恰是「板那一侧真的用了那一对」。上一版板这一侧
     * 一条断言都没有，于是「改板不改记忆」全绿、「改记忆不改板」两条红，漂只朝一个方向走。
     *
     * 辨识特征：板那一行的标签前面挂着编号和一个全角冒号（`  ①：凭什么：…；…`），
     * 记忆那两行行首是两个空格。上面那两条与下面这两条因此不会互相顶替。
     */
    expect(contextWithMemory).toContain(`：凭什么：${memory.rationale}；`);
    expect(contextWithMemory).toContain(
      `；什么新证据会把它重新打开：${memory.overturnConditions.join("；")}`
    );
  });

  it("标签一条都不重的议题，装配时取不到记忆", async () => {
    // 自给自足：先确保库里真有一条记忆，否则「取不到」是因为库是空的
    await confirmOn((await shakingIssue(2)).id, {
      statement: "份额按出货面积算，不按片数",
      basis: "片数口径把大尺寸的量算小了",
      boundary: "这个判断只说统计口径，不说定价",
      reopenIf: "行业统计全面改用片数口径",
    });
    expect(getDecisionMemories().length).toBeGreaterThan(0);

    /*
     * 他自己提的这一条**接不出域**、也不动摇任何在版判断（`addIssue` 里 `judgmentRefs`
     * 写死是 `[]`），于是 `issueTagsOf` 算出来是空数组，与任何一条记忆零重合。
     *
     * 验收标准：把 `pickDecisionMemories(store.decisionMemories, issueTags, 5)` 换成
     * `store.decisionMemories.slice(0, 5)` → 这条会红。
     */
    const fresh = await api.addIssue("海外仓要不要自建");
    expect(fresh.judgmentRefs).toEqual([]);
    expect(fresh.domainId).toBeUndefined();
    expect(await api.advisorContext(fresh.id)).not.toContain("相关决策记忆");
  });

  it("新证据里逐字出现某条重开条件时，前缀里带上命中提示", async () => {
    /*
     * 命中提示读的是 `doc.ledger`，所以这条得挑一件**有深研报告**的议题；证据从
     * 对谈追加证据那条既有入口（`landTalkEvidence`）落进台账，与轮内取证同一条路。
     *
     * 验收标准：删掉 buildAdvisorContext 里 hitOverturn 那一段 → 这条会红。
     */
    const issue = await shakingIssue(3);
    expect(await api.getResearchDoc(issue.id)).not.toBeNull();

    const candidate = {
      statement: "海外仓这一轮不自建",
      basis: "三方仓当前履约时效稳定在 1.8 日",
      boundary: "这个判断只说自建仓，不说前置仓",
      reopenIf: "三方仓履约时效跌破两日达",
    };
    const memory = await confirmOn(issue.id, candidate);

    // 命中之前：同一件议题的前缀里没有这一段
    expect(await api.advisorContext(issue.id)).not.toContain("新证据命中了以下几条重开条件");

    await api.landTalkEvidence(issue.id, [
      {
        id: "E1",
        claim: "2026 上半年三方仓履约时效跌破两日达，实测 2.4 日",
        exactQuote: "……履约时效 2.4 日……",
        siteName: "国家统计局",
        sourceTier: "A",
        sourceDomain: "stats.gov.cn",
        url: "https://example.invalid/wms",
        retrievedAt: "2026-08-27",
        independenceGroup: "G1",
      } as unknown as import("@/lib/research/ledger").Evidence,
    ]);

    const context = await api.advisorContext(issue.id);
    expect(context).toContain("新证据命中了以下几条重开条件");
    expect(context).toContain(
      `决策记忆「${memory.judgment}」的重开条件「${candidate.reopenIf}」已被新证据命中`
    );
  });

  it("用户卡接上了：卡里那份压缩产物真的进了前缀", async () => {
    /*
     * `store.userCard` 现在没有任何生产写者（抽取器按裁定 3 是欠账），所以消费侧
     * 只能由 `__setUserCardForTest` 扮那个写者。不这么钉一下，`buildAdvisorContext`
     * 里那一整块删掉全套照旧全绿 —— 等抽取器接上那天才发现前缀里根本没这一块。
     *
     * 验收标准：删掉 buildAdvisorContext 里用户卡那一段 → 这条会红。
     */
    const card: UserCard = {
      challengeDimensions: [{ dimension: "统计口径混用", count: 9, sessions: ["S1"] }],
      longTermViews: [],
      preferences: { granularity: "要机制不要罗列" },
    };
    setUserCard(card);
    try {
      const context = await api.advisorContext((await shakingIssue(0)).id);
      /*
       * 断的是**具体那几行字**，不是 `toContain(packUserCard(card))` —— 那个期望值是
       * 被测的同一条路自己算的：`packUserCard` 回空串时它退化成 `toContain("")`，恒真。
       */
      expect(context).toContain("粒度偏好：要机制不要罗列");
      expect(context).toContain("常挑战维度：");
      expect(context).toContain("统计口径混用（出现 9 次）");
      // 提示词正文里一律称「他」——「一号位」只出现在注释里
      expect(context).toContain("他的表达偏好与他常挑的那几个口径");
      expect(context).not.toContain("一号位的表达偏好");
    } finally {
      // 卡是全局一份，留着会漏进同文件后面的用例
      setUserCard(null);
    }
  });
});
