/**
 * 起来的时候库里有什么、以及他自己提一件事那条路。
 *
 * ## 这个文件的规则 2026-08-30 变过一次
 *
 * 原来这里钉的是「上线第一天那一屏是空的：一件议题、一张卡都没有」。理由是三条来路
 * （雷达抓的、DRI 押上名字递的、他自己提的）里雷达还没接、A1a 的立案写回还没接，所以
 * 预置任何一条都等于替某条来路编了一次来历。
 *
 * 现在库里预载了一套案例（`seed-cases.ts`）。**那条理由并没有被推翻，是被满足了**：
 * 那套案例每一条都写明自己照的是哪两份真实材料、哪几个数还没查，屏幕上分得出它是什么。
 * 空着一屏换来的不是诚实，是没法验收。
 *
 * 所以这个文件现在钉两件事：
 *
 *   1. **预载的是那一套，不是别的。** 本体那九条（`seed-tokenking`）和 ISS-101
 *      （`seed-agent-domain`）仍然不许被装进来 —— 「留在种子文件里」和「装进 store」
 *      是两件事，而它们进来就是替那三条来路编来历。
 *   2. **他自己提一件事那条路照旧**：落成一条 `Candidate` 加一张卡，不是一条在办议题；
 *      而且不让任何一个域的在办计数动一下。
 *
 * 只碰数据层：`store.ts` 在进程内现算。**`addIssue` 会顺手起一轮预研** —— 那是产品行为
 * （见 `ensurePreResearch`），不是这里要验的东西，所以下面把假模型打开，免得跑一次单测
 * 出网、甚至花钱。那一轮在假模型下会就地失败（`mock.ts` 里还没有 `a3.pre-research` 的罐头），
 * 与这几条断言无关。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照 —— 否则这几条断言跟着开发机上的现场数据飘。
  process.env.TKOS_PERSIST = "0";
  // 单测里一次模型都不许真调用：这台机器上可能导出着真 key。
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("./store")).api;
});

describe("起来的时候库里有什么", () => {
  it("首页左下是词元云集自己的六个域", async () => {
    // 2026-08-31：01 方向与经营选择、02 Transformation 连同挂在它们下面的东西一起去掉了
    // （见 `scripts/gen-seed-from-ontology.mjs` 的 `DROPPED_DOMAINS`）。
    const domains = await api.listDomains();
    expect(domains.map((d) => d.id)).toEqual([
      "D-03",
      "D-04",
      "D-05",
      "D-06",
      "D-07",
      "D-08",
    ]);
    // DRI 那一栏是岗位名（本体里在位人待确认），但不能是空的。
    expect(domains.every((d) => d.driName.length > 0)).toBe(true);
  });

  it("预载的那套案例在，而且每一档都有东西", async () => {
    /*
     * 一档一档数，而不是只断「总数大于零」：这一套的意义正是**每一个环节都有真东西**，
     * 少了哪一档，屏幕上就有一栏是空的 —— 而空栏和「这一栏坏了」在屏幕上长得一样。
     */
    const issues = await api.listIssues();
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.id.startsWith("ISS-2"))).toBe(true);

    const candidates = issues.filter((i) => i.state === "Candidate");
    const researching = issues.filter((i) => !i.settled && i.state !== "Candidate");
    const deployed = issues.filter(
      (i) => i.settled && i.state !== "Closed" && i.state !== "Dismissed",
    );
    expect(candidates.length).toBeGreaterThan(0); // 提请台
    expect(researching.filter((i) => !i.readyForMeeting).length).toBeGreaterThan(0); // 还在研究
    expect(researching.filter((i) => i.readyForMeeting && !i.slot).length).toBeGreaterThan(0); // 可以排会
    expect(researching.filter((i) => i.slot).length).toBeGreaterThan(0); // 已排会
    expect(issues.filter((i) => i.debrief).length).toBeGreaterThan(0); // 等确认会后要点
    expect(deployed.length).toBeGreaterThan(0); // 已部署

    // 提请台上摊着的就是那几张卡，而且是今天这一批。
    expect((await api.listPending()).length).toBe(candidates.length);
  });

  it("排下的那几场会里有一场是横跨两个域的", async () => {
    /*
     * 这一条是这套案例存在的理由之一：**一场会横跨两个域**正是这个产品要证明的事。
     * 案例里没有它的话，「参会域是算出来的」那一层永远走不到有意思的那一支。
     */
    const issues = await api.listIssues();
    const slots = await api.listSlots();
    const domainOf = new Map(issues.map((i) => [i.id, i.domainId] as const));
    const spans = slots.filter(
      (s) => new Set(s.issueIds.map((id) => domainOf.get(id)).filter(Boolean)).size > 1,
    );
    expect(spans.length).toBeGreaterThan(0);
  });

  it("本体那九条和 ISS-101 都没有被装进来", async () => {
    // 种子文件里还有它们（生成器照本体如实生成、ISS-101 是卡长什么样的样板），
    // 但 store 里取不到。这一条钉的是「留在文件里」和「装进 store」是两件事。
    await expect(api.getIssue("ISS-001")).rejects.toThrow();
    await expect(api.getIssue("ISS-101")).rejects.toThrow();
  });

  it("判断还在 —— 空的是议题，不是他的在版判断", async () => {
    // 本体那几十条判断第一天就该在：它们是他已经定过的事，不是等他处置的东西。
    // 清空议题不能顺手把这一层也清掉（04 域这两条正是 ISS-101 挂着的那两条）。
    const detail = await api.getJudgment("04-J1");
    expect(detail.judgment.statement.length).toBeGreaterThan(0);
    // 而它没有被任何议题动摇 —— 第一天本来就该是这样，不是漏算。
    expect(detail.shakingIssues).toEqual([]);
  });
});

describe("他自己提的那一件", () => {
  it("落成一条 Candidate 加一张卡，不是一条在办议题", async () => {
    const before = await api.listPending();
    const domainsBefore = await api.listDomains();
    const issue = await api.addIssue("要不要现在就把 Foundry 的定价重做一遍");

    expect(issue.state).toBe("Candidate");
    expect(issue.origin).toBe("manual");
    // 他刚想到，系统不该替他排下一步动作。
    expect(issue.nextActionForUser).toBeNull();

    // 提请台上多出来的**正好是他这一条**（数不是从零起了，所以断的是增量）。
    const after = await api.listPending();
    expect(after).toHaveLength(before.length + 1);
    const mine = after.find((c) => c.issueId === issue.id);
    expect(mine).toBeTruthy();
    // 自动抓取还没接，写 radar 就是在给来路撒谎（见 `cardSourceLabel`）。
    expect(mine!.source).toEqual({ kind: "ceo" });
    // 没有判断可挂，接不出域 —— 留空是诚实的空，归域在他按下「聊聊」那一刻才定。
    expect(mine!.domainIds).toEqual([]);

    /*
     * 而它**没有让任何一个域的在办计数动一下**。
     *
     * 这一条是这个用例真正在钉的东西：`Candidate` 还没被他采信，计进域的在办数就等于
     * 屏幕替他做了那个决定。所以断的是「和刚才一模一样」，不是「全都是 0」——
     * 预载案例本来就让好几个域有在办的事。
     */
    const domainsAfter = await api.listDomains();
    expect(domainsAfter.map((d) => d.openIssues)).toEqual(
      domainsBefore.map((d) => d.openIssues),
    );
  });

  it("空标题不收", async () => {
    await expect(api.addIssue("   ")).rejects.toThrow("议题不能是空的");
  });
});

/**
 * 同一个框收进来的三种东西，落到卡上是三个样子。这里验的是**卡面**这一头
 * （分支本身在 `own-issue-input.test.ts`）：哪一张卡有原文、哪一张没有、
 * 「标题是参谋起的」那行小字该不该出现。
 *
 * 假模型开着，所以起标题那一下拿到的是 `mock.ts` 里 `own.title` 那罐罐头。
 */
describe("他递进来的是一整篇的时候，卡上长什么样", () => {
  const cardFor = async (issueId: string) => {
    const card = (await api.listPending()).find((c) => c.issueId === issueId);
    if (!card) throw new Error(`没找到 ${issueId} 那张卡`);
    return card;
  };

  it("标题归参谋起，原文整段进卡的 what", async () => {
    const long = `贝壳在成都把二手房抽佣从 2.5% 降到 2%。${"这一段是他贴进来的正文。".repeat(30)}`;
    const issue = await api.addIssue(long);
    const card = await cardFor(issue.id);

    // 标题不是那一整篇 —— 卡面那一行放不下六百字。
    expect(card.headline).not.toBe(long);
    expect(card.headline.length).toBeLessThan(60);
    expect(issue.title).toBe(card.headline);
    // 详情页那行「标题是参谋起的」靠这个字段亮。
    expect(card.titleByModel).toBe(true);
    // 原文一个字没少地留在卡上（卡面靠渐变毛玻璃裁掉多出来的部分，不是靠少存）。
    expect(card.what).toHaveLength(1);
    expect(card.what[0].text).toBe(long);
    // 他自己贴的，溯源就写这一句 —— 没有文档号也没有链接可给。
    expect(card.what[0].traces[0].kind).toBe("human");
  });

  it("一句话那一张卡没有原文段，也没有那行小字", async () => {
    const issue = await api.addIssue("成都的抽佣是不是已经压到我们进不去了");
    const card = await cardFor(issue.id);

    expect(card.headline).toBe("成都的抽佣是不是已经压到我们进不去了");
    // 同一句话在卡上大字一遍、小字再一遍，看着像系统坏了。
    expect(card.what).toEqual([]);
    // 标题就是他自己写的，标一句「参谋起的」是假话。
    expect(card.titleByModel).toBeUndefined();
    expect(card.materialNote).toBeUndefined();
  });
});
