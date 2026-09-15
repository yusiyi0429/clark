import { describe, expect, it } from "vitest";

import {
  insertDivergences,
  readDivergences,
  stanceMaterial,
  stancesOf,
  stripRefs,
  type LaneStance,
} from "./divergence";
import { fixtureReport } from "./fixture";
import { lintStored } from "./lint";
import type { DivergenceViewBlock, ReportBlocks } from "./schema";

/** 三条链路各一份报告。内容同一份就够了 —— 这一步比的是立场，不是文风。 */
const laneReport = (short: string, tweak?: (r: ReportBlocks) => void): ReportBlocks => {
  const r = structuredClone(fixtureReport());
  r.lane = { model: short.toLowerCase(), short };
  tweak?.(r);
  return r;
};

const stances = (): LaneStance[] =>
  stancesOf([
    { label: "DeepSeek", report: laneReport("DeepSeek") },
    { label: "Claude", report: laneReport("Claude") },
    { label: "ChatGPT", report: laneReport("ChatGPT") },
  ]);

/** 模型交回来的那一行。故意收 `Record` 而不是 `DivergenceViewBlock`：这里要能造出坏形状。 */
const view = (o: Record<string, unknown>): string =>
  JSON.stringify({
    type: "divergence_view",
    topic: "掉量是需求不足还是调度不足",
    adjudication: { status: "待裁决", method: "事实核查", note: "" },
    ...o,
  });

const P = (lane: string, extra: Record<string, unknown> = {}) => ({
  lane,
  verdict: "这一方的裁决",
  keyBasis: "凭什么",
  confidence: "当前更支持",
  ...extra,
});

describe("链路代号", () => {
  it("按收到的顺序发甲乙丙", () => {
    expect(stances().map((s) => `${s.alias}=${s.label}`)).toEqual([
      "甲=DeepSeek",
      "乙=Claude",
      "丙=ChatGPT",
    ]);
  });
});

describe("递给模型的立场材料", () => {
  const m = stanceMaterial(stances());

  it("只出现代号，不出现模型名字", () => {
    /*
     * 裁决那一次跑在 pro 上，而写了「DeepSeek」那一份的就是它。表上写着它自己的名字时，
     * 它偏向哪一栏这件事从此说不清。
     */
    expect(m).toContain("### 链路甲");
    expect(m).toContain("### 链路丙");
    expect(m).not.toContain("DeepSeek");
    expect(m).not.toContain("ChatGPT");
  });

  it("带上每条判断的证伪条件和把握，不带报告正文", () => {
    expect(m).toContain("电价不是这一轮的决定变量");
    expect(m).toContain("什么会推翻它：");
    expect(m).toContain("把握 当前更支持");
    // 表格、口径脚注这些是报告的形状，递进去它就会去写一份「综合结论」。
    expect(m).not.toContain("机房类型");
    expect(m).not.toContain("上架率＝已上架机柜");
  });

  it("说明这一条取回了几条证据、什么档次 —— 三分法要分的正是它", () => {
    expect(m).toMatch(/取回证据：\d+ 条（A×\d/);
  });

  it("一个证据编号都不带 —— 跨链路引不通", () => {
    expect(m).not.toContain("[E");
  });

  it("这一份自己没能核实的那几条要带上", () => {
    expect(m).toContain("这一份自己没能核实：");
    expect(m).toContain("改造型机房的调度池不可用机时占比");
  });
});

describe("去掉行内证据编号", () => {
  it("连编号前面那个空格一起去掉", () => {
    expect(stripRefs("上架是瓶颈 [E2]。")).toBe("上架是瓶颈。");
    expect(stripRefs("两处转载 [E1，E4] 同源")).toBe("两处转载 同源");
  });
});

describe("读模型交回来的分歧", () => {
  it("代号映射回屏幕上那两三个字", () => {
    const { views, notes } = readDivergences(view({ positions: [P("甲"), P("乙")] }), stances());
    expect(views).toHaveLength(1);
    expect(views[0].positions.map((p) => p.lane)).toEqual(["DeepSeek", "Claude"]);
    expect(notes).toEqual([]);
  });

  it("它忍不住写真名时也认", () => {
    const { views } = readDivergences(
      view({ positions: [P("链路甲"), P("ChatGPT"), P("claude")] }),
      stances()
    );
    expect(views[0].positions.map((p) => p.lane)).toEqual(["DeepSeek", "ChatGPT", "Claude"]);
  });

  it("认不出的那一方丢掉，剩下两方照收", () => {
    const { views, notes } = readDivergences(
      view({ positions: [P("甲"), P("乙"), P("Gemini")] }),
      stances()
    );
    expect(views[0].positions).toHaveLength(2);
    expect(notes.join("")).toContain("Gemini");
  });

  it("丢到只剩一方就整处不要 —— 一方没有分歧", () => {
    const { views, notes } = readDivergences(view({ positions: [P("甲"), P("Gemini")] }), stances());
    expect(views).toEqual([]);
    expect(notes.join("")).toContain("只剩 1 方");
  });

  it("同一方摆两次只留第一次", () => {
    const { views, notes } = readDivergences(
      view({ positions: [P("甲", { verdict: "先说的" }), P("甲", { verdict: "后说的" }), P("乙")] }),
      stances()
    );
    expect(views[0].positions.map((p) => p.verdict)).toEqual(["先说的", "这一方的裁决"]);
    expect(notes.join("")).toContain("摆了两次");
  });

  it("命题、立场、依据里的证据编号一律去掉", () => {
    /*
     * 编号是每条链路自己台账里的：甲的 E3 和乙的 E3 是两页不同的东西。原样带进主源那一份，
     * 屏幕上那枚芯片会指到主源的第三条证据上 —— 一句话配了一张别人的凭证。
     */
    const { views } = readDivergences(
      view({
        topic: "掉量的成因 [E5]",
        positions: [P("甲", { keyBasis: "计费成功率同向 [E5]" }), P("乙", { verdict: "调度侧 [E2]" })],
      }),
      stances()
    );
    expect(JSON.stringify(views)).not.toContain("[E");
    expect(views[0].topic).toBe("掉量的成因");
  });

  it("「欠定 + 事实核查」就地改成「需内部数据」，并且记一条", () => {
    // 任务书 §4.3 的三分法。不改的话 A4-B09 会把它判成 p0，而这一支没有重写轮。
    const { views, notes } = readDivergences(
      view({
        positions: [P("甲"), P("乙")],
        adjudication: { status: "欠定", method: "事实核查", note: "" },
      }),
      stances()
    );
    expect(views[0].adjudication.method).toBe("需内部数据");
    expect(notes.join("")).toContain("按三分法改成");
    // 记账进 trace，不写进块自己的 note —— 那一栏是给一号位读的。
    expect(views[0].adjudication.note).toBe("");
  });

  it("「待裁决 + 事实核查」原样留着 —— 那一种不矛盾", () => {
    const { views, notes } = readDivergences(view({ positions: [P("甲"), P("乙")] }), stances());
    expect(views[0].adjudication).toEqual({ status: "待裁决", method: "事实核查", note: "" });
    expect(notes).toEqual([]);
  });

  it("同一个命题折了两遍只留第一遍", () => {
    const two = [
      view({ positions: [P("甲"), P("乙")] }),
      view({ positions: [P("甲"), P("丙")] }),
    ].join("\n");
    const { views, notes } = readDivergences(two, stances());
    expect(views).toHaveLength(1);
    expect(notes.join("")).toContain("折了两遍");
  });

  it("交了别的块丢掉并记一条 —— 这一步只收 divergence_view", () => {
    const mixed = [
      JSON.stringify({ type: "prose", md: "顺手写了一段总结。" }),
      view({ positions: [P("甲"), P("乙")] }),
    ].join("\n");
    const { views, notes } = readDivergences(mixed, stances());
    expect(views).toHaveLength(1);
    expect(notes.join("")).toContain("prose");
  });

  it("「没有分歧」是合法答案，不记成一行坏掉的 JSON", () => {
    const { views, notes } = readDivergences("没有分歧", stances());
    expect(views).toEqual([]);
    expect(notes.join("")).toContain("各条对得上");
    expect(notes.join("")).not.toContain("读不通");
  });

  it("超过六处就丢掉后面的，并且写明丢了哪几处", () => {
    // 静默截断的表现是「这一轮只有六处分歧」，而那是一句假话。
    const many = Array.from({ length: 8 }, (_, i) =>
      view({ topic: `第 ${i + 1} 处分歧`, positions: [P("甲"), P("乙")] })
    ).join("\n");
    const { views, notes } = readDivergences(many, stances());
    expect(views).toHaveLength(6);
    expect(notes.join("")).toContain("第 7 处分歧");
    expect(notes.join("")).toContain("第 8 处分歧");
  });

  it("围栏照旧容错，用的是同一个解析器", () => {
    const fenced = ["```json", view({ positions: [P("甲"), P("乙")] }), "```"].join("\n");
    expect(readDivergences(fenced, stances()).views).toHaveLength(1);
  });
});

describe("插进主源那一份", () => {
  const one: DivergenceViewBlock = {
    type: "divergence_view",
    topic: "新折出来的这一处",
    positions: [
      { lane: "DeepSeek", verdict: "甲的裁决", keyBasis: "凭什么", confidence: "当前更支持" },
      { lane: "Claude", verdict: "乙的裁决", keyBasis: "凭什么", confidence: "初步提示" },
    ],
    adjudication: { status: "待裁决", method: "程序执行", note: "先把两个口径算齐" },
  };

  it("插在推翻条件那张卡之前 —— 那张卡收在最后", () => {
    const out = insertDivergences(fixtureReport(), [one]);
    const at = out.blocks.findIndex((b) => b.type === "divergence_view" && b.topic === one.topic);
    const card = out.blocks.findIndex((b) => b.type === "falsify_card");
    const list = out.blocks.findIndex((b) => b.type === "evidence_list");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(list);
    expect(at).toBeLessThan(card);
  });

  it("一处都没折出来时原样返回", () => {
    const r = fixtureReport();
    expect(insertDivergences(r, [])).toBe(r);
  });

  it("不改原来那一份 —— 它此刻正摆在屏幕上", () => {
    const r = fixtureReport();
    const n = r.blocks.length;
    insertDivergences(r, [one]);
    expect(r.blocks).toHaveLength(n);
  });

  it("插进去之后重过一遍闸，不多出一条 p0", () => {
    /*
     * 这是这一步唯一的硬账：跨链路的依据用话说清、不带编号，所以证据表一个字没变 ——
     * A4-B06「引了证据表里没有的编号」不会被这一步惹出来。
     */
    const out = insertDivergences(fixtureReport(), [one]);
    expect(lintStored(out).filter((x) => x.severity === "p0")).toEqual([]);
  });

  it("重过那一遍认得出新插的块里的自相矛盾", () => {
    const bad: DivergenceViewBlock = {
      ...one,
      adjudication: { status: "欠定", method: "程序执行", note: "" },
    };
    const out = insertDivergences(fixtureReport(), [bad]);
    expect(lintStored(out).filter((x) => x.severity === "p0").map((x) => x.rule)).toEqual(["A4-B09"]);
  });

  it("原来没有 report_meta 的那一份，重过闸时那条 p0 还在", () => {
    // meta 是**重建**而不是凭空补：无条件造一个出来会把「少了 report_meta」悄悄抹掉。
    const r = fixtureReport();
    r.title = "";
    expect(lintStored(r).map((x) => x.message).join("")).toContain("少了 report_meta");
  });
});
