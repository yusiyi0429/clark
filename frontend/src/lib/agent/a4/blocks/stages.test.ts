/**
 * 分节生成那半边确定性的东西（补遗 §1）。
 *
 * 这一层要拦的三件事在屏幕上都长得像一份正常的报告：大纲漏派了两条证据、某一节把上一节的
 * 数字又展开了一遍、拼起来之后有三块互相矛盾的对账。所以每一条都各有一个用例钉着。
 */
import { describe, expect, it } from "vitest";

import { parseBlocks } from "./parse";
import {
  assembleStaged,
  crossSectionRepeats,
  keyPointsOf,
  mergeUsage,
  readOutline,
  usageMaterial,
} from "./stages";
import type { Block } from "./schema";

const PACK = ["E1", "E2", "E3", "E4"];

const blocksOf = (...lines: unknown[]): Block[] =>
  parseBlocks(`${lines.map((x) => JSON.stringify(x)).join("\n")}\n`, { complete: true }).blocks;

const prose = (md: string) => ({ type: "prose", heading: "一节", md });

describe("readOutline", () => {
  it("正常那一份原样读出来", () => {
    const r = readOutline(
      {
        thesis_draft: "瓶颈在上架不在卡",
        sections: [
          {
            id: "S1",
            title: "装机在涨",
            question: "涨了多少",
            evidence_ids: ["E1", "E2"],
            expected_blocks: ["kpi_cards"],
            min_blocks: 3,
          },
          { id: "S2", title: "上架没跟上", question: "差在哪", evidence_ids: ["E3", "E4"], min_blocks: 2 },
        ],
      },
      PACK
    );
    expect(r.notes).toEqual([]);
    expect(r.outline.thesisDraft).toBe("瓶颈在上架不在卡");
    expect(r.outline.sections.map((s) => s.evidenceIds)).toEqual([
      ["E1", "E2"],
      ["E3", "E4"],
    ]);
    expect(r.outline.sections[0].minBlocks).toBe(3);
  });

  /*
   * 2026-08-31 之前这一节是被丢掉的。一号位把口径翻过来了：靠推理写出来的那一节正是他要
   * 的东西，丢掉它等于让零证据的那几轮只剩材料盘点。所以现在留着，只记一条提醒。
   */
  it("一条证据都没分到的节留着，只记一条提醒 —— 那一节靠推理撑", () => {
    const r = readOutline(
      {
        sections: [
          { id: "S1", title: "有证据的", evidence_ids: ["E1", "E2", "E3", "E4"] },
          { id: "S2", title: "凭既有知识写的那一节", evidence_ids: [] },
        ],
      },
      PACK
    );
    expect(r.outline.sections.map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(r.notes.join()).toContain("一条证据都没分到");
    expect(r.notes.join()).toContain("推理链和证伪条件");
  });

  it("零证据那一轮的兜底节问的是议题本身，不是「材料说得出什么」", () => {
    /*
     * 钉的是 `RUN-A4-mth5jkf0-6` 那一份塌掉的报告：兜底节原来叫「这一轮的材料说得出什么」，
     * 问法是「材料合起来回答了哪一部分」—— 问材料，答案当然只关于材料。
     */
    const r = readOutline(null, []);
    const s = r.outline.sections[0];
    expect(s.title).not.toContain("材料说得出什么");
    expect(s.question).toContain("答案是什么");
    expect(s.question).toContain("不要写成不表态");
  });

  it("两边都没提到的证据补进最后一节，不替它编弃用理由", () => {
    const r = readOutline({ sections: [{ id: "S1", title: "只派了两条", evidence_ids: ["E1", "E2"] }] }, PACK);
    expect(r.outline.sections[0].evidenceIds).toEqual(["E1", "E2", "E3", "E4"]);
    expect(r.outline.unassigned).toEqual([]);
    expect(r.notes.join()).toContain("E3、E4");
  });

  it("写进 unassigned 的不算漏派", () => {
    const r = readOutline(
      {
        sections: [{ id: "S1", title: "三条", evidence_ids: ["E1", "E2", "E3"] }],
        unassigned: [{ id: "E4", reason: "与 E1 同源且更旧" }],
      },
      PACK
    );
    expect(r.outline.sections[0].evidenceIds).toEqual(["E1", "E2", "E3"]);
    expect(r.outline.unassigned).toEqual([{ id: "E4", reason: "与 E1 同源且更旧" }]);
    expect(r.notes.join()).not.toContain("E4");
  });

  it("大纲整个答歪了折成一节，涵盖全部编号", () => {
    for (const raw of [null, "不是 JSON", {}, { sections: "S1、S2" }]) {
      const r = readOutline(raw, PACK);
      expect(r.outline.sections).toHaveLength(1);
      expect(r.outline.sections[0].evidenceIds).toEqual(PACK);
      expect(r.notes.length).toBeGreaterThan(0);
    }
  });

  it("台账里没有的编号一律不认 —— 大纲编不出证据来", () => {
    const r = readOutline(
      { sections: [{ id: "S1", title: "混了一个不存在的", evidence_ids: ["E1", "E9"] }] },
      PACK
    );
    expect(r.outline.sections[0].evidenceIds).toContain("E1");
    expect(r.outline.sections[0].evidenceIds).not.toContain("E9");
  });

  it("min_blocks 给 0 不接受：那等于「这一节可以不写」", () => {
    const r = readOutline({ sections: [{ id: "S1", title: "x", evidence_ids: PACK, min_blocks: 0 }] }, PACK);
    expect(r.outline.sections[0].minBlocks).toBeGreaterThanOrEqual(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 排结构塌了：毛坯大纲那一支（ISS-240）                                         */
/* -------------------------------------------------------------------------- */

/**
 * 钉的是 `RUN-A4-mtqtenit-2`：排结构只分到 46 秒、网关 45 秒超时，于是折成一节、那一节也
 * 没时间写，**正文 1 块、0/1 节、24 条证据一条都没交代**。这一组要的是「同样的塌法下，
 * 手上有毛坯时交出来的是一份有章节的报告」。
 */
describe("readOutline —— 排结构没成时按决策骨架分节", () => {
  const skeletonSection = (id: string, title: string, evidenceIds: string[]) => ({
    id,
    title,
    question: `${title} 这条判断还站得住吗`,
    evidenceIds,
    expectedBlocks: ["prose", "judgment"],
    minBlocks: 1,
  });

  const FALLBACK = {
    sections: [
      skeletonSection("S1", "先把验收口径谈定", ["E1"]),
      skeletonSection("S2", "中尺寸先不扩产", []),
      skeletonSection("S3", "产能先给整机厂", ["E9"]),
    ],
    note: "排结构那一次没成，已按 N1 的决策骨架分成 3 节",
  };

  it("骨架有 3 条 → 分成 3 节，不折成一节", () => {
    const r = readOutline(null, PACK, { minBlocksFloor: 1, fallback: FALLBACK });
    expect(r.outline.sections.map((s) => s.title)).toEqual([
      "先把验收口径谈定",
      "中尺寸先不扩产",
      "产能先给整机厂",
    ]);
    expect(r.notes[0]).toBe(FALLBACK.note);
    // 「折成一节」那一句一个字都不该出现 —— 两条路的产物完全不同，说岔了没人查得出来。
    expect(r.notes.join()).not.toContain("已折成一节");
  });

  it("证据一条都不许静默消失：分不到的补进最后一节，台账里没有的不认", () => {
    const r = readOutline(null, PACK, { minBlocksFloor: 1, fallback: FALLBACK });
    const placed = r.outline.sections.flatMap((s) => s.evidenceIds);
    // PACK 是 E1–E4：E1 按 N4 的策略更新分给了 S1，剩下三条落在最后一节。
    expect([...new Set(placed)].sort()).toEqual([...PACK].sort());
    expect(r.outline.sections[0].evidenceIds).toEqual(["E1"]);
    expect(r.outline.sections[2].evidenceIds).toEqual(["E2", "E3", "E4"]);
    // 骨架上那个 E9 是模型在策略更新里写的，本轮台账里没有 —— 兜底这条路不松这道闸。
    expect(placed).not.toContain("E9");
    expect(r.notes.join()).toContain("已补进最后一节");
  });

  it("一节一个块就答完了它那一问 —— 骨架这几节的下限是 1，不按默认的 2", () => {
    const r = readOutline(null, PACK, { fallback: FALLBACK });
    expect(r.outline.sections.map((s) => s.minBlocks)).toEqual([1, 1, 1]);
  });

  it("骨架是空的（行业题、或者 N1 也砸了）→ 折成一节那条老路一个字不变", () => {
    const plain = readOutline(null, PACK);
    const empty = readOutline(null, PACK, { fallback: { sections: [], note: "不该被用上的那一句" } });
    expect(empty.outline).toEqual(plain.outline);
    expect(empty.notes).toEqual(plain.notes);
    expect(empty.notes.join()).toContain("已折成一节，涵盖全部证据");
  });

  it("模型真交出了章节时骨架一节都不用 —— 毛坯只在精修失败时顶上", () => {
    const r = readOutline({ sections: [{ id: "S1", title: "模型排的", evidence_ids: PACK }] }, PACK, {
      fallback: FALLBACK,
    });
    expect(r.outline.sections.map((s) => s.title)).toEqual(["模型排的"]);
    expect(r.notes.join()).not.toContain("决策骨架");
  });
});

describe("mergeUsage", () => {
  it("used 由代码从正文数出来，evidence_list 里列着不算用上", () => {
    const blocks = blocksOf(
      prose("装机口径见 [E1]，上架率 62% [E2]。"),
      {
        type: "evidence_list",
        items: [{ id: "E3", claim: "只是列着", sourceName: "某研究院", sourceType: "行业研究" }],
      }
    );
    const a = mergeUsage({ packIds: PACK, blocks, declared: [] });
    expect(a.block.used).toEqual(["E1", "E2"]);
    expect(a.uncovered).toEqual(["E3", "E4"]);
  });

  it("声明过弃用理由的进 discarded，理由一个字都不改写", () => {
    const blocks = blocksOf(prose("只引了 [E1]。"));
    const a = mergeUsage({
      packIds: PACK,
      blocks,
      declared: [
        { id: "E2", reason: "与 E1 是同一份数据的转载，时点更旧" },
        { id: "E3", reason: "说的是另一个议题" },
      ],
    });
    expect(a.block.discarded).toEqual([
      { id: "E2", reason: "与 E1 是同一份数据的转载，时点更旧" },
      { id: "E3", reason: "说的是另一个议题" },
    ]);
    expect(a.uncovered).toEqual(["E4"]);
  });

  it("两处都声明了同一条时留第一条理由", () => {
    const a = mergeUsage({
      packIds: PACK,
      blocks: [],
      declared: [
        { id: "E1", reason: "与 E2 共源" },
        { id: "E1", reason: "与本议题无关" },
      ],
    });
    expect(a.block.discarded).toEqual([{ id: "E1", reason: "与 E2 共源" }]);
  });

  it("既被引上、又被声明弃用的那一条按「用上了」算", () => {
    // 反过来的话它会同时出现在 used 和 discarded 里，而那份对账自己就打起来了。
    const a = mergeUsage({
      packIds: PACK,
      blocks: blocksOf(prose("这一段引了 [E1]。")),
      declared: [{ id: "E1", reason: "（某一节自己弃用了它）" }],
    });
    expect(a.block.used).toContain("E1");
    expect(a.block.discarded).toEqual([]);
  });

  it("没人交代的那几条不补「未使用」—— 补了 A4-B11 就永远过得去", () => {
    const a = mergeUsage({ packIds: PACK, blocks: [], declared: [] });
    expect(a.block.discarded).toEqual([]);
    expect(a.uncovered).toEqual(PACK);
    // 那一段人话要明说别编理由：收口那一次手上没有这几条的内容。
    expect(usageMaterial(a)).toContain("不要替它们编一条理由");
  });
});

/**
 * 收口那一次原来照着这段材料把整张表誊一遍，而**誊回来的那份没有一个字被采用**：`used` 由
 * 代码从正文里算，`discarded` 里各节已经声明过的那几条在上面「留第一条理由」那一条里被挡掉。
 * 剩下真正需要它写的，只有 `uncovered` 那几条。
 *
 * 那一轮它为此写了 10016 个 token、240 秒（`RUN-A4-mtlbtxzl-2`），按实测 50 tok/s 的吞吐，
 * 誊写的每一千字都是二十秒 —— 而这一轮的时间是和联网取证共用的。
 *
 * 这几条盯的是那段人话**说对了话**：两栏只供判断、不供誊抄；没有待交代的那几条时整块不写
 * （写一个两栏皆空的 evidence_usage 会被 `parseBlocks` 判成坏行，见 `schema.ts` 那句
 * 「两边都空的那一行没有任何内容可对账」）。
 */
describe("usageMaterial：收口该抄什么、不该抄什么", () => {
  const account = (blocks: Block[], declared: { id: string; reason: string }[] = []) =>
    mergeUsage({ packIds: PACK, blocks, declared });

  it("有没交代的：明说只写这几条、used 交空数组", () => {
    const m = usageMaterial(account(blocksOf(prose("这一段引了 [E1]。"))));
    expect(m).toContain("只写这几条");
    expect(m).toContain("空数组");
    expect(m).toContain("E2");
  });

  it("一条没交代的都没有：明说这一块整个不写", () => {
    const m = usageMaterial(
      account(blocksOf(prose("这一段引了 [E1] [E2] [E3] [E4]。")))
    );
    expect(m).toContain("不要写 evidence_usage 这一块");
    expect(m).not.toContain("只写这几条");
  });

  it("用上的那份名单照旧递过去 —— 收口写 evidence_list 要用，只是不许抄回来", () => {
    const m = usageMaterial(account(blocksOf(prose("这一段引了 [E1]。"))));
    expect(m).toContain("用上了：E1");
    expect(m).toContain("抄回来的那一份不会被采用");
  });
});

describe("crossSectionRepeats", () => {
  const section = (id: string, md: string) => ({ id, title: id, blocks: blocksOf(prose(md)) });

  it("同一个数在两节各展开一遍，交一条线索", () => {
    const out = crossSectionRepeats([
      section("S1", "样本机房上架率 62%，这是本轮的口径。"),
      section("S2", "上架率 62% 说明调度没跟上。"),
    ]);
    expect(out.join()).toContain("62%");
    expect(out.join()).toContain("S1、S2");
  });

  it("年份和证据编号不算重复线索", () => {
    const out = crossSectionRepeats([
      section("S1", "截至 2026 年的口径见 [E1]。"),
      section("S2", "2026 年的另一件事见 [E1]。"),
    ]);
    expect(out).toEqual([]);
  });

  it("只在一节里出现的数不报", () => {
    const out = crossSectionRepeats([
      section("S1", "电价 0.42 元/kWh。"),
      section("S2", "上架率 62%。"),
    ]);
    expect(out).toEqual([]);
  });
});

describe("assembleStaged", () => {
  const outline = readOutline(
    {
      thesis_draft: "草稿",
      sections: [
        { id: "S1", title: "第一节", evidence_ids: ["E1", "E2"] },
        { id: "S2", title: "第二节", evidence_ids: ["E3", "E4"] },
      ],
    },
    PACK
  ).outline;

  const jsonl = (...lines: unknown[]) => `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`;

  const s1 = jsonl(
    { type: "prose", heading: "第一节", md: "装机口径见 [E1]，上架率见 [E2]。" },
    { type: "evidence_usage", used: ["E1", "E2"], discarded: [] }
  );
  const s2 = jsonl({ type: "prose", heading: "第二节", md: "另一条口径见 [E3]。" });
  const closing = jsonl(
    { type: "report_meta", title: "收口定的标题", confidence: "较强支持", dataCutoff: "2026-08-20" },
    { type: "verdict_banner", text: "答案在这里 [E1]。", confidence: "较强支持", boundary: "只对样本成立" },
    {
      type: "judgment",
      claim: "最终判断",
      confidence: "较强支持",
      direction: "支持",
      evidenceRefs: ["E1"],
      falsifyCondition: "样本外那批机房的上架率也在 60% 以上",
    },
    { type: "evidence_usage", used: ["E1"], discarded: [{ id: "E4", reason: "与 E1 同源" }] },
    { type: "falsify_card", conditions: ["样本外那批机房也是这个数"], monitoringIndicators: [] }
  );

  it("各节交的横幅降成段落，收口多交的也降，一份报告只留收口那一个（2026-09-05）", () => {
    const s1b = jsonl(
      { type: "verdict_banner", heading: "第一节", text: "这一节的横幅 [E1]", confidence: "初步提示", boundary: "只在这一节成立" },
      { type: "evidence_usage", used: ["E1"], discarded: [] }
    );
    const closing2 = closing + jsonl({ type: "verdict_banner", text: "第二个横幅", confidence: "初步提示", boundary: "" });
    const r = assembleStaged({ outline, sections: [{ id: "S1", text: s1b }, { id: "S2", text: s2 }], closing: closing2, packIds: PACK });
    const p = parseBlocks(r.text, { complete: true });
    expect(p.bad).toEqual([]);
    expect(p.blocks.filter((b) => b.type === "verdict_banner")).toHaveLength(1);
    const demoted = p.blocks.find((b) => b.type === "prose" && b.heading === "第一节");
    expect(demoted && demoted.type === "prose" ? demoted.md : "").toContain("这一节的横幅");
    expect(demoted && demoted.type === "prose" ? demoted.md : "").toContain("适用边界：只在这一节成立");
    expect(p.blocks.some((b) => b.type === "prose" && b.md === "第二个横幅")).toBe(true);
    expect(r.notes.join("")).toContain("2 个多出来的横幅");
  });

  it("evidenceRefs 里不像编号的项剔掉，编号形状的照留 —— 那一栏是给编号用的，不是给话用的", () => {
    const s1n = jsonl(
      { type: "prose", heading: "第一节", md: "全靠推理。" },
      { type: "judgment", claim: "推出来的判断", confidence: "初步提示", direction: "支持", evidenceRefs: ["本节推理，待内部记录核", "K1"], falsifyCondition: "内部记录相反" },
      { type: "kpi_cards", heading: "三个数", cards: [{ value: "95", unit: "%", label: "门槛", caliberNote: "设定值", evidenceRefs: ["公司经营原则：Outcome 先于任务", " S3-K1 "] }] }
    );
    const closingN = jsonl(
      { type: "report_meta", title: "标题", confidence: "初步提示", dataCutoff: "2026-09-05" },
      { type: "verdict_banner", text: "答案", confidence: "初步提示", boundary: "" }
    );
    const r = assembleStaged({ outline, sections: [{ id: "S1", text: s1n }], closing: closingN, packIds: [] });
    expect(r.text).not.toContain("本节推理");
    expect(r.text).not.toContain("公司经营原则");
    const p = parseBlocks(r.text, { complete: true });
    const j = p.blocks.find((b) => b.type === "judgment");
    expect(j && j.type === "judgment" ? j.evidenceRefs : ["x"]).toEqual(["K1"]);
    const k = p.blocks.find((b) => b.type === "kpi_cards");
    expect(k && k.type === "kpi_cards" ? k.cards[0].evidenceRefs : ["x"]).toEqual(["S3-K1"]);
  });

  it("顺序是他读下来的顺序，不是调用顺序", () => {
    const r = assembleStaged({ outline, sections: [{ id: "S1", text: s1 }, { id: "S2", text: s2 }], closing, packIds: PACK });
    const p = parseBlocks(r.text, { complete: true });
    expect(p.bad).toEqual([]);
    expect(p.meta?.title).toBe("收口定的标题");
    expect(p.blocks.map((b) => b.type)).toEqual([
      "verdict_banner",
      "prose",
      "prose",
      "judgment",
      "evidence_usage",
      "falsify_card",
    ]);
  });

  it("模型交的那几份 evidence_usage 全摘掉，只留代码合出来的一块", () => {
    const r = assembleStaged({ outline, sections: [{ id: "S1", text: s1 }, { id: "S2", text: s2 }], closing, packIds: PACK });
    const usage = parseBlocks(r.text, { complete: true }).blocks.filter((b) => b.type === "evidence_usage");
    expect(usage).toHaveLength(1);
    // used 是代码从正文数出来的（E1/E2/E3 都引了），不是收口那一份说的「只有 E1」。
    expect(usage[0].type === "evidence_usage" && usage[0].used).toEqual(["E1", "E2", "E3"]);
    expect(usage[0].type === "evidence_usage" && usage[0].discarded).toEqual([
      { id: "E4", reason: "与 E1 同源" },
    ]);
    expect(r.usage.uncovered).toEqual([]);
  });

  it("收口没跑成：报告照样拼出来，缺了什么记进 notes", () => {
    const r = assembleStaged({ outline, sections: [{ id: "S1", text: s1 }], closing: "", packIds: PACK });
    expect(parseBlocks(r.text, { complete: true }).blocks.length).toBeGreaterThan(0);
    expect(r.notes.join()).toContain("没有交出 report_meta");
  });

  it("没人交代的证据进 notes，并点名 A4-B11 会拒", () => {
    const r = assembleStaged({ outline, sections: [{ id: "S1", text: s1 }], closing: "", packIds: PACK });
    expect(r.usage.uncovered).toEqual(["E3", "E4"]);
    expect(r.notes.join()).toContain("A4-B11");
  });

  it("某一节有坏行时记账，不丢掉那一节剩下的块", () => {
    const broken = `${s2.trim()}\n{"type":"prose","md":"这一行没写完`;
    const r = assembleStaged({ outline, sections: [{ id: "S2", text: broken }], closing, packIds: PACK });
    expect(r.notes.join()).toContain("S2 那一节有 1 行没解析出来");
    expect(parseBlocks(r.text, { complete: true }).blocks.some((b) => b.type === "prose")).toBe(true);
  });
});

describe("keyPointsOf", () => {
  it("往下一节递的是要点，不是正文", () => {
    const blocks = blocksOf(
      {
        type: "kpi_cards",
        cards: [{ value: "62", unit: "%", label: "上架率", caliberNote: "已上架/已交付" }],
      },
      {
        type: "judgment",
        claim: "瓶颈在上架",
        confidence: "较强支持",
        direction: "支持",
        evidenceRefs: ["E2"],
        falsifyCondition: "反例",
      },
      { type: "prose", md: "这一段有好几句话。第二句不该进要点。" }
    );
    const out = keyPointsOf({ id: "S1", title: "第一节" }, blocks);
    expect(out).toContain("S1　第一节");
    expect(out).toContain("上架率 62%");
    expect(out).toContain("判断：瓶颈在上架（较强支持）");
    expect(out).not.toContain("第二句不该进要点");
  });
});
