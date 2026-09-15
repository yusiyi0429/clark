import { describe, expect, it } from "vitest";

import type { Violation } from "@/lib/agent/rules";

import { FIXTURE_JSONL, FIXTURE_LEDGER, fixtureReport } from "./fixture";
import { lintAssembled, lintBlocks, mustRewrite, rejectedFrom } from "./lint";
import { assembleReport } from "./report";
import type { Block, ReportBlocks } from "./schema";

const base = (): ReportBlocks => structuredClone(fixtureReport());

/** 取某一种块（第一个）。改它一处，就是一个拦截用例。 */
function pick<T extends Block["type"]>(r: ReportBlocks, type: T): Extract<Block, { type: T }> {
  const b = r.blocks.find((x) => x.type === type);
  if (!b) throw new Error(`fixture 里没有 ${type}`);
  return b as Extract<Block, { type: T }>;
}

const lint = (r: ReportBlocks): Violation[] =>
  lintBlocks({
    meta: { title: r.title, confidence: r.confidence, dataCutoff: r.dataCutoff },
    blocks: r.blocks,
    evidence: r.evidence,
    ...(r.bad ? { bad: r.bad } : {}),
  });

const p0 = (r: ReportBlocks): string[] => lint(r).filter((x) => x.severity === "p0").map((x) => x.rule);
const messages = (r: ReportBlocks, rule: string): string =>
  lint(r).filter((x) => x.rule === rule).map((x) => x.message).join(" || ");

describe("验收 fixture 本身是干净的", () => {
  it("一条违规都没有 —— 有的话下面每个用例都在测噪声", () => {
    expect(lint(base())).toEqual([]);
    expect(mustRewrite(lint(base()))).toBe(false);
  });
});

describe("§4.2 四条拦截", () => {
  it("① 无证据的数字：KPI 卡", () => {
    const r = base();
    pick(r, "kpi_cards").cards[0].evidenceRefs = [];
    expect(p0(r)).toContain("A4-B02");
    expect(messages(r, "A4-B02")).toContain("上架率");
  });

  it("① 无证据的数字：正文里那一句", () => {
    const r = base();
    const prose = pick(r, "prose");
    prose.md = prose.md.replace(/\s*\[E\d+\]/g, "");
    expect(p0(r)).toContain("A4-B02");
  });

  it("① 世代线、时限、报告自己的条目数不算数字（ISS-232 七条 B02 里六条是它们，2026-09-06）", () => {
    const r = base();
    const prose = pick(r, "prose");
    prose.md =
      "8.6 代线是反过来的。首访后 48 小时内在书面纪要里确认。这三样任何一样缺失都不计分，另外 17 条未核断言现场一句都不要问。前者是 6 代基板的屏体产线。";
    expect(messages(r, "A4-B02")).not.toContain("prose");
  });

  it("① 漏斗和对比条的数也算数字：没有引用整块拒", () => {
    const r = base();
    for (const st of pick(r, "funnel").stages) delete st.note;
    expect(p0(r)).toContain("A4-B02");
  });

  it("① 年份、型号、第 N 节里的数字不算 —— 那一类不该被拦", () => {
    const r = base();
    pick(r, "prose").md = "2026 年这一轮的 H100 集群在第 3 节里讲过，结论没有变。";
    expect(lint(r).filter((x) => x.rule === "A4-B02" && x.severity === "p0")).toEqual([]);
  });

  it("② 缺证伪条件的判断", () => {
    const r = base();
    pick(r, "judgment").falsifyCondition = "";
    expect(p0(r)).toContain("A4-B03");
    expect(messages(r, "A4-B03")).toContain("说不出什么会推翻它");
  });

  it("② 压根没写分档的判断（写了「初步提示」的不算）", () => {
    const r = base();
    const j = pick(r, "judgment");
    j.confidence = "初步提示";
    expect(lint(r).filter((x) => x.rule === "A4-B03" && x.severity === "p0")).toEqual([]);
    j.defaulted = ["confidence"];
    expect(p0(r)).toContain("A4-B03");
  });

  /*
   * 2026-08-31 翻过来的那一条。原来「一条证据都没引」直接 p0，于是零证据的那几轮里每条
   * 判断都挂一条改不掉的 p0 —— 模型学得会的唯一避法是不下判断。现在门槛是「说得出理由」：
   * 证据和推理二选一，两个都缺才拦。
   */
  it("② 没引证据但写了推理链 —— 不拦，只提醒确认证伪条件", () => {
    const r = base();
    const j = pick(r, "judgment");
    j.evidenceRefs = [];
    j.reasoningSummary =
      "执行层切入之所以出不了可复制的案例，是因为一线任务的验收标准散在人身上；" +
      "验收标准不可机读，交付方就无法把一次成功复制到第二家，这一步在哪一层切入都绕不过去。";
    expect(lint(r).filter((x) => x.rule === "A4-B03" && x.severity === "p0")).toEqual([]);
    expect(messages(r, "A4-B03")).toContain("靠推理成立");
  });

  it("② 既没引证据、推理链也只有一句 —— 照旧 p0，那是裸断言", () => {
    const r = base();
    const j = pick(r, "judgment");
    j.evidenceRefs = [];
    j.reasoningSummary = "材料有限。";
    expect(p0(r)).toContain("A4-B03");
    expect(messages(r, "A4-B03")).toContain("没有证据的时候，答案是你怎么推出来的");
  });

  it("③ 内部DOC 混进外部判断", () => {
    const r = base();
    pick(r, "judgment").evidenceRefs.push("E7");
    expect(p0(r)).toContain("A4-B04");
    expect(messages(r, "A4-B04")).toContain("E7");
  });

  it("③ 内部DOC 出现在「对我们的当前含义」那一节是合法的", () => {
    // fixture 里 E7 只出现在那一节和证据清单里 —— 那一份是干净的（上一组已经断言过）。
    const r = base();
    const inward = r.blocks.find((b) => b.type === "prose" && b.heading === "对我们的当前含义");
    expect(inward).toBeTruthy();
    if (inward?.type === "prose") inward.heading = "行业含义";
    expect(p0(r)).toContain("A4-B04");
  });

  it("④ 共源证据当成三个来源", () => {
    const r = base();
    // E1 与 E4 是同一篇稿子的两处转载（台账里同一个 independenceGroup）。
    pick(r, "judgment").evidenceRefs = ["E1", "E4"];
    expect(p0(r)).toContain("A4-B05");
    expect(messages(r, "A4-B05")).toContain("共源×2");
  });
});

describe("其余几条", () => {
  it("引了证据表里没有的编号", () => {
    const r = base();
    pick(r, "prose").md += "补一句没有出处的引用 [E42]。";
    expect(p0(r)).toContain("A4-B06");
    expect(messages(r, "A4-B06")).toContain("E42");
  });

  it("两个核心判断横幅等于没有结论", () => {
    const r = base();
    r.blocks.push(structuredClone(pick(r, "verdict_banner")));
    expect(p0(r)).toContain("A4-B01");
  });

  it("一个 judgment 都没有 = 这一轮上不了判断板", () => {
    const r = base();
    r.blocks = r.blocks.filter((b) => b.type !== "judgment");
    expect(p0(r)).toContain("A4-B01");
  });

  it("算式引了没声明的参数", () => {
    const r = base();
    pick(r, "param_model").outputs[0].expr = "price * kwh * 24";
    expect(p0(r)).toContain("A4-B08");
    expect(messages(r, "A4-B08")).toContain("kwh");
  });

  it("算式压根读不通", () => {
    const r = base();
    pick(r, "param_model").outputs[0].expr = "price * (kw";
    expect(p0(r)).toContain("A4-B08");
  });

  it("「欠定」配「事实核查」是自相矛盾 —— 那读起来像再查一轮就有答案", () => {
    const r = base();
    pick(r, "divergence_view").adjudication.method = "事实核查";
    expect(p0(r)).toContain("A4-B09");
  });

  it("坏行只记账，不触发重写", () => {
    const r = base();
    r.bad = [{ line: 7, text: '{"type":"prose"', why: "这一行不是合法 JSON" }];
    const v = lint(r);
    expect(v.map((x) => x.rule)).toContain("A4-B10");
    expect(mustRewrite(v)).toBe(false);
  });

  it("成本结构的断言没有计算器：记一条，不挡", () => {
    const r = base();
    pick(r, "prose").md += "电费占收入约 22% [E3]。";
    r.blocks = r.blocks.filter((b) => b.type !== "param_model");
    const v = lint(r);
    expect(v.filter((x) => x.rule === "A4-B07").map((x) => x.severity)).toEqual(["p1"]);
  });

  it("取回来没用上、也没交代过的证据记一条", () => {
    const r = base();
    // E4 是这一份里唯一正文没引的那条。清单和弃用声明都撤掉，它才成孤儿。
    r.blocks = r.blocks.filter((b) => b.type !== "evidence_list" && b.type !== "evidence_usage");
    const v = lint(r);
    expect(v.filter((x) => x.rule === "A4-B06").map((x) => x.severity)).toContain("p1");
  });

  it("在 evidence_usage 里声明了弃用理由的不算孤儿", () => {
    /*
     * 两条规则读的是同一份声明。不减掉的话 E4 会同时收到 A4-B06 的「一次都没用上」和
     * A4-B11 的「已交代」—— 而运营台上那两条并排摆着，读的人只能自己猜哪一条是真的。
     */
    const r = base();
    r.blocks = r.blocks.filter((b) => b.type !== "evidence_list");
    expect(lint(r).filter((x) => x.rule === "A4-B06")).toEqual([]);
  });
});

describe("A4-B11 证据利用率那一笔账", () => {
  /*
   * 这一条要拦的那一种报告在别的每一道门前面都是干净的：取回十八条、写进去六条、剩下
   * 十二条没人提。所以这一组用例全都从「一份合规的报告」出发，只动那笔账。
   */
  const b11 = (r: ReportBlocks) => lint(r).filter((x) => x.rule === "A4-B11");

  it("既没被引、也没声明弃用的证据整份拒", () => {
    const r = base();
    // E4 是 fixture 里唯一正文没引的那条：清单和弃用声明一起撤掉，它就成了无人提及的那一条。
    r.blocks = r.blocks.filter((b) => b.type !== "evidence_list" && b.type !== "evidence_usage");
    const v = b11(r);
    expect(v.map((x) => x.severity)).toContain("p0");
    expect(v[0].message).toContain("E4");
    // 压根没有那一块时不按到某个块上：按上去等于让模型去改一个没错的块。
    expect(v[0].message).toContain("压根没有 evidence_usage");
    expect(v[0].block).toBeUndefined();
    expect(mustRewrite(v)).toBe(true);
  });

  it("代码不替它补 —— 少一块 evidence_usage 不等于那几条被交代过了", () => {
    // 这一条钉的是「不许自动补」。补一句「未使用」，上面那个用例就永远绿，而它要拦的正是那一种。
    const r = base();
    r.blocks = r.blocks.filter((b) => b.type !== "evidence_list" && b.type !== "evidence_usage");
    const usage = lint(r).filter((x) => x.rule === "A4-B11");
    expect(usage.length).toBeGreaterThan(0);
  });

  it("只写编号没写理由 = 没交代", () => {
    // 没有理由的弃用和漏掉一条，在屏幕上长得一样。
    const r = base();
    pick(r, "evidence_usage").discarded[0].reason = "  ";
    expect(p0(r)).toContain("A4-B11");
    expect(messages(r, "A4-B11")).toContain("E4");
  });

  it("说弃用了、正文里又拿它当依据：记一条，不挡", () => {
    const r = base();
    pick(r, "prose").md += "另外那份转载也给了同一个数 [E4]。";
    const v = b11(r);
    expect(v.map((x) => x.severity)).toEqual(["p1"]);
    expect(v[0].message).toContain("两边对不上");
  });

  it("列进 evidence_list 不算「正文引了」—— 老实摆出来的弃用声明不该被判自相矛盾", () => {
    // fixture 的 evidence_list 里就有 E4，而它同时被声明弃用。这一份是干净的（第一组已断言过）。
    expect(b11(base())).toEqual([]);
  });

  it("对账对到了包外面", () => {
    const r = base();
    pick(r, "evidence_usage").used.push("E42");
    const v = b11(r);
    expect(v.map((x) => x.severity)).toEqual(["p1"]);
    expect(v[0].message).toContain("E42");
  });

  it("声明在账上、正文没引的那一条，used 里写着也算交代过", () => {
    /*
     * 这一条是给分节那条路留的口子：`stages.ts` 合出来的 `used` 是代码从正文数出来的，
     * 而返修那一轮模型可能只改了账没改正文。账上写着就不再拒 —— 拒了会把返修卡在一个
     * 它已经答过的问题上。正文引没引由 A4-B02/B06 各自去管。
     */
    const r = base();
    const u = pick(r, "evidence_usage");
    u.discarded = [];
    u.used = ["E1", "E2", "E3", "E4", "E5"];
    expect(b11(r)).toEqual([]);
  });
});

describe("违规 → 要重发哪几块", () => {
  const assembled = (text = FIXTURE_JSONL) =>
    assembleReport({ text, entries: FIXTURE_LEDGER, lane: { model: "m", short: "M" }, complete: true });

  it("校验器填的块序号真的指得回那一块 —— 不靠从报错原话里抠序号", () => {
    // 第一张 KPI 卡的证据引用抠掉：一个没有出处的数。
    const a = assembled(FIXTURE_JSONL.replace('"evidenceRefs":["E2"]', '"evidenceRefs":[]'));
    const r = rejectedFrom(lintAssembled(a), a.blocks, a.sources);
    expect(r.rejected).toHaveLength(1);
    expect(a.blocks[r.rejected[0].at - 1].type).toBe("kpi_cards");
    expect(JSON.parse(r.rejected[0].line).type).toBe("kpi_cards");
    expect(r.rejected[0].why).toContain("A4-B02");
    expect(r.needsMeta).toBe(false);
  });

  it("进这一轮只由 p0 决定；进来之后那一块的 p1 一起改", () => {
    const a = assembled();
    const r = rejectedFrom(
      [
        { rule: "A4-B02", severity: "p0", message: "有卡没绑证据", block: 2 },
        { rule: "A4-B02", severity: "p1", message: "没写口径脚注", block: 2 },
        // 只有 p1 的块不进 —— 为一条「建议补口径」把过了闸的块推回去重写不值。
        { rule: "A4-B03", severity: "p1", message: "没有升档条件", block: 5 },
      ],
      a.blocks,
      a.sources
    );
    expect(r.rejected.map((x) => x.at)).toEqual([3]);
    expect(r.rejected[0].line).toBe(a.sources[2]);
    expect(r.rejected[0].why).toContain("没写口径脚注");
    expect(r.general).toBe("");
  });

  it("报告级的那几条进 general，不硬按到某个块上", () => {
    const a = assembled();
    const r = rejectedFrom(
      [{ rule: "A4-B06", severity: "p0", message: "正文引了证据表里没有的编号 E9" }],
      a.blocks,
      a.sources
    );
    expect(r.rejected).toEqual([]);
    expect(r.general).toContain("E9");
    expect(r.needsMeta).toBe(false);
  });

  it("缺元数据单独一档：它不属于任何块，只能让它重交那一行", () => {
    const a = assembled(FIXTURE_JSONL.split("\n").slice(1).join("\n"));
    const r = rejectedFrom(lintAssembled(a), a.blocks, a.sources);
    expect(r.needsMeta).toBe(true);
    expect(r.general).not.toContain("report_meta");
  });

  it("越界的块序号丢掉 —— 不去改一个不存在的块", () => {
    const a = assembled();
    const r = rejectedFrom(
      [{ rule: "A4-B02", severity: "p0", message: "…", block: 999 }],
      a.blocks,
      a.sources
    );
    expect(r.rejected).toEqual([]);
  });
});
