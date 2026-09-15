import { describe, expect, it } from "vitest";
import {
  ANCHOR_GATE_BATCH_SYSTEM,
  ANCHOR_GATE_SYSTEM,
  buildAnchorGateBatchUser,
  buildAnchorGateUser,
  hooksOf,
  readAnchorBatchVerdicts,
  readAnchorVerdict,
  stripHooks,
} from "./anchor-gate";
import type { Block } from "./blocks/schema";

const j = (hooks: string[]): Block => ({
  type: "judgment",
  claim: "c",
  confidence: "当前更支持",
  direction: "支持",
  reasoningSummary: "r",
  upgradeCondition: "u",
  falsifyCondition: "f",
  evidenceRefs: ["E1"],
  internalValidationHooks: hooks,
});

describe("锚点相关性检查", () => {
  it("只答两种话，答「能」要带命题号", () => {
    expect(readAnchorVerdict("能 + D2-P1")).toEqual({ pass: true, propositionId: "D2-P1" });
    expect(readAnchorVerdict("不能")).toEqual({ pass: false, propositionId: "" });
  });

  it("答「能」但指不出命题号，当不通过 —— 指不出来就是没有对应物", () => {
    expect(readAnchorVerdict("能")).toEqual({ pass: false, propositionId: "" });
  });

  it("提示词只问一句，明写只答两种", () => {
    expect(ANCHOR_GATE_SYSTEM).toContain("只答");
    expect(buildAnchorGateUser({ industry: "柔性 AMOLED", anchor: "AIDC 域算力资产观察", propositions: ["D2-P1 x"] })).toContain("AIDC");
  });
});

describe("摘掉没过检查的锚点", () => {
  it("留下过了检查的，摘掉别的，并说出摘了什么", () => {
    const r = stripHooks([j(["AIDC 域算力资产观察", "董办投喂通道的行业监控卡片"])], ["董办投喂通道的行业监控卡片"]);
    expect((r.blocks[0] as { internalValidationHooks: string[] }).internalValidationHooks).toEqual(["董办投喂通道的行业监控卡片"]);
    expect(r.removed).toEqual(["AIDC 域算力资产观察"]);
  });

  it("数得出这一份里全部待检的锚点，去重", () => {
    expect(hooksOf([j(["a", "b"]), j(["b"])])).toEqual(["a", "b"]);
  });

  it("不是 judgment 的块原样不动", () => {
    const blocks: Block[] = [{ type: "prose", md: "x" }];
    expect(stripHooks(blocks, []).blocks).toEqual(blocks);
  });
});

describe("锚点相关性检查 · 合批（2026-09-04）", () => {
  it("按行首序号归位，没答到的、答不出序号的、答「能」没命题号的都不过", () => {
    const r = readAnchorBatchVerdicts("1 能 D2-P1\n2 不能\n3 能\n随便一句\n5. 能 D7-P2", 5);
    expect(r.map((x) => x.pass)).toEqual([true, false, false, false, true]);
    expect(r[0].propositionId).toBe("D2-P1");
    expect(r[4].propositionId).toBe("D7-P2");
  });

  it("序号越界不炸，长度恒等于送检条数", () => {
    expect(readAnchorBatchVerdicts("9 能 D1-P1\n0 能 D1-P1", 2).map((x) => x.pass)).toEqual([false, false]);
    expect(readAnchorBatchVerdicts("", 3)).toHaveLength(3);
  });

  it("user 段把每条锚点编上号，system 段要求逐行作答", () => {
    const u = buildAnchorGateBatchUser({ industry: "柔性 AMOLED", anchors: ["甲", "乙"], propositions: ["D2-P1 x"] });
    expect(u).toContain("1. 甲");
    expect(u).toContain("2. 乙");
    expect(u).toContain("共 2 条");
    expect(ANCHOR_GATE_BATCH_SYSTEM).toContain("有几条锚点就答几行");
  });
});
