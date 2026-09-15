/**
 * 取证那六段串起来跑一遍。**离线，一个字节都不出网。**
 *
 * `TKOS_MODEL_MOCK=1` 下这一条链是真跑的：假检索给地址 → `fetch.mockPage` 出正文 →
 * 罐头抽取给引句 → 入账（三道闸真判）→ 独立性折叠 → 覆盖判定 → 三条义务判定。只有
 * 「检索」和「模型」两头是假的，中间每一段都是上线要跑的那一份代码。
 *
 * 所以这个文件同时钉两件事：那六段接得上，以及**罐头夹具还配得上它们**。罐头里的引句
 * 跟 `mockPage` 的假正文是逐字对应的（见 `models/mock.ts` 的注释），谁改一边忘了另一边，
 * 这里会红成「一条都没入账」而不是在某次线上运行里表现成「这题没搜到东西」。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { Harness } from "@/lib/agent/harness";
import { mockText } from "@/lib/models/mock";
import { providers } from "@/lib/research/search";

import { gatherEvidence } from "./evidence";
import { compile } from "./props";

/** 罐头命题：两条，第二条故意查不到（假正文里只有第一条要的那句数字）。 */
const props = () => compile(JSON.parse(mockText("a4.props")), 4);

let out: Awaited<ReturnType<typeof gatherEvidence>>;

beforeAll(async () => {
  process.env.TKOS_MODEL_MOCK = "1";
  const h = new Harness({ agent: "A4", slot: "pro" });
  // 深度按 high 那一档的预算：searchK 5、maxRounds 2。写死数字而不是读 DEPTH，
  // 是为了让「有人调了 high 的预算」在这里显形，而不是让断言跟着一起变。
  out = await gatherEvidence(h, providers().list, props(), { searchK: 5, maxRounds: 2 }, {
    // 一条链路的身份。`substep` 在这里是空转：没有 progress 的 harness 本来也不报进度，
    // 而这条用例验的是取证那六段，不是屏幕上那行字。
    slot: "pro",
    label: "DeepSeek",
    substep: () => {},
  });
});

describe("离线也要真的走完六段", () => {
  it("罐头命题编译出两条", async () => {
    const p = props();
    expect(p.map((x) => x.id)).toEqual(["P1", "P2"]);
    expect(p[0].material).toBe(true);
    expect(p[0].counterQueries.length).toBeGreaterThan(0);
  });

  it("入账不为空 —— 空台账说明罐头引句和假正文对不上了", async () => {
    expect(out.ledger.entries.length).toBeGreaterThan(0);
    for (const e of out.ledger.entries) {
      // 每一条都过了引句定位，坐标落在原文里。
      expect(e.verificationStatus).toBe("span_matched");
      expect(e.excerpt.length).toBeGreaterThan(0);
      expect(e.span[1]).toBeGreaterThan(e.span[0]);
    }
  });

  it("抽取器不许决定 url —— 地址由代码填", async () => {
    // 模型手抄 url 抄错一个字符就变成「没抓过的地址」而被拒，而真正的原因在拒绝理由里
    // 看不出来。所以每条入账的地址必须是本轮真抓过的那一页。
    for (const e of out.ledger.entries) expect(out.ledger.snapshot(e.url)).toBeTruthy();
  });

  it("折叠给出多于一组的独立来源", async () => {
    /*
     * 假页各自带一个署名机构（`fetch.MOCK_ORGS`），所以出处归因分得出组。这一条红了
     * 通常意味着假页的署名又撞到了一起 —— 那时覆盖判定在离线下永远过不了，而屏幕上
     * 只表现成「这题证据不够」。
     */
    const groups = new Set(out.ledger.entries.map((e) => e.independenceGroup));
    expect(groups.size).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(g.startsWith("src:")).toBe(true);
  });

  it("查得到的那条闭合，查不到的那条落终态", async () => {
    // 一边全过、一边全不过，才说明判定真的在按数看，而不是跟着轮数一起翻。
    const p1 = out.verdicts.find((v) => v.propositionId === "P1")!;
    const p2 = out.verdicts.find((v) => v.propositionId === "P2")!;
    expect(p1.ok).toBe(true);
    expect(p1.terminal).toBe("");
    expect(p2.ok).toBe(false);
    expect(p2.terminal).toBe("unknown_snapshot_gap");
  });

  it("没闭合的那条用完补搜轮数才收 —— 不是第一轮就放弃", async () => {
    expect(out.rounds.map((r) => r.no)).toEqual([1, 2]);
    // 第二轮只服务还没闭合的那一条。
    expect(out.rounds[0].propositionIds).toEqual(["P1", "P2"]);
    expect(out.rounds[1].propositionIds).toEqual(["P2"]);
  });

  it("反向检索每一轮都发", async () => {
    // 只在第一轮发的话，补搜轮里那条行为义务就靠「上一轮发过」记账 —— 那等于让一条
    // 行为义务由历史满足。
    for (const r of out.rounds) expect(r.counterQueries).toBeGreaterThan(0);
  });

  it("每一轮的账都记全了，入账和被拒分开数", async () => {
    /*
     * 「抽了 10 条进了 10 条」和「抽了 10 条进了 0 条」在报告上长得一样，只有这两个数
     * 分得开。漏斗少一格就说不清是哪一段掉的。
     *
     * 各轮 `recorded` 相加要等于台账条数 —— 这是漏斗和台账唯一的对账点。**不是**「第一轮
     * 就等于台账」：补搜轮换了问法就会搜到没抓过的页（`fresh` 那一步只滤已抓的地址），
     * 于是它也在往台账里加。写成第一轮等于全量，等于默许补搜轮白跑。
     */
    const first = out.rounds[0];
    expect(first.hits).toBeGreaterThan(0);
    expect(first.fetched).toBeGreaterThan(0);
    expect(first.rejected).toBe(0);
    expect(first.searchErrors).toEqual([]);
    const recorded = out.rounds.reduce((n, r) => n + r.recorded, 0);
    expect(recorded).toBe(out.ledger.entries.length);
    // 每一轮都真的往台账里加了东西 —— 一轮 0 入账说明那一轮的页全被拒或全没抓到。
    for (const r of out.rounds) expect(r.recorded).toBeGreaterThan(0);
  });

  it("每家各出了几条也记着 —— 离线只有一家，键就只有一个", async () => {
    /*
     * 这一格是「同时用几家」的凭据，所以它必须一直被填。离线只有假检索一家，那也要有
     * 它的账 —— 空对象意味着换成两家真检索时屏幕上那句「哪家给了几条」是空的。
     */
    const first = out.rounds[0];
    expect(Object.keys(first.hitsByProvider)).toEqual(["mock"]);
    const acc = first.hitsByProvider.mock;
    expect(acc.label).toBe("假检索（离线）");
    // 一家独跑时，去重前后的差就是「几条检索式撞到了同一页」。
    expect(acc.unique).toBe(first.hits);
    expect(acc.returned).toBeGreaterThanOrEqual(acc.unique);
  });
});
