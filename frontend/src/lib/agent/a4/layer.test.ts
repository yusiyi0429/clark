import { describe, expect, it } from "vitest";
import { APPENDIX_TYPES, bodyShare, layerGaps, partition } from "./layer";
import type { Block, ReportBlocks } from "./blocks/schema";

const prose = (md: string): Block => ({ type: "prose", md });
const judgment = (): Block => ({
  type: "judgment",
  claim: "c",
  confidence: "当前更支持",
  direction: "支持",
  reasoningSummary: "r",
  upgradeCondition: "u",
  falsifyCondition: "f",
  evidenceRefs: ["E1"],
  internalValidationHooks: [],
});

const report = (blocks: Block[]): ReportBlocks =>
  ({ title: "t", confidence: "当前更支持", dataCutoff: "2026-08-26", lane: { model: "m", short: "s" }, evidencePackId: "p", blocks, evidence: [] }) as ReportBlocks;

describe("正文与附录切分", () => {
  it("校验机械那几类块进附录", () => {
    const r = partition([prose("正文"), judgment()]);
    expect(r.body.map((b) => b.type)).toEqual(["prose"]);
    expect(r.appendix.map((b) => b.type)).toEqual(["judgment"]);
  });

  it("附录那张表里有判断、证伪条件、证据台账、弃用清单、待核清单、口径", () => {
    for (const t of ["judgment", "falsify_card", "evidence_list", "evidence_usage", "unverified_panel", "caliber_map"]) {
      expect(APPENDIX_TYPES).toContain(t);
    }
  });

  it("论点、机制、关键数留在正文", () => {
    for (const t of ["verdict_banner", "prose", "kpi_cards", "layered_table", "bar_compare", "scenario_cards"]) {
      expect(APPENDIX_TYPES).not.toContain(t);
    }
  });
});

describe("正文占比", () => {
  it("正文比附录短时占比小于一半", () => {
    expect(bodyShare(report([prose("短"), judgment(), judgment()]))).toBeLessThan(0.5);
  });
});

describe("正文禁令", () => {
  it("正文里出现「答得出/答不出」要报出来", () => {
    expect(layerGaps(report([prose("这组数答得出份额，答不出价格")])).join("")).toContain("答得出");
  });

  // 「集中一段 vs 散落各处」—— 一块里多次提及是集中讨论，通过；多块各提一次是到处重复，拒绝。
  it("口径在一个块里提多次 = 集中讨论，不报", () => {
    const text = "口径上有两条限制。……另外口径上还要说明一句。";
    expect(layerGaps(report([prose(text)])).join("")).not.toContain("口径");
  });

  it("口径散落在 2+ 块里要报出来", () => {
    expect(layerGaps(report([prose("口径上限定一条"), prose("另一个口径注释")])).join("")).toContain("口径");
  });

  it("正文超过全文八成要报出来（2026-09-04 从六成抬上来：正文压短之后六成是常态，不是缺陷）", () => {
    const long = prose("正".repeat(5000));
    expect(layerGaps(report([long, judgment()])).join("")).toContain("80%");
  });

  /*
   * `RUN-A4-mth5jkf0-6` 那一份：收口被掐断，附录一个块都没有，于是这条报「正文占 82%」，
   * 打回的指令是「把机械搬进附录」—— 而那一轮该做的是重跑收口。指错方向的打回比不打回贵。
   * 漏判的风险由 lint 的 A4-B01 兜着（judgment / falsify_card 都在附录侧，一个都没有是 p0）。
   */
  it("一个附录块都没有的时候不判正文占比 —— 那一份缺的是收口，不是位置", () => {
    const long = prose("正".repeat(5000));
    expect(layerGaps(report([long])).join("")).not.toContain("80%");
  });

  it("拿「证据不足以判断」当维度论点要报出来", () => {
    expect(layerGaps(report([prose("论点：证据不足以判断这一维")])).join("")).toContain("证据不足");
  });
});
