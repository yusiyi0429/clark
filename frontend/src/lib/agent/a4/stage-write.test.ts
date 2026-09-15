/**
 * N5 分层成稿的单测。
 *
 * ## 为什么这几条不做成离线端到端断言
 *
 * 这一段最要紧的一条是「N4 的合并稿真的递给了写报告的那几次调用」。它**在整轮离线跑里断言
 * 不出来**：`models/mock.ts` 的分节罐头是一张静态表，它不回声输入，所以「合并稿的内容出现在
 * 最终报告里」这条在离线下永远是假的 —— 而为了让它变真去改那张罐头，测的就成了罐头写得好
 * 不好，不是这一段递没递。
 *
 * 所以这里自己接一个记账的假 `Harness`：`writeStaged` 交给模型的每一条消息都存下来，断言
 * 大纲/分节/收口那三次各自看到了什么。折成一段话的那几个纯函数（`mergedFor`、
 * `loadBearingUnverified`、`assignDims`、`cardBrief`、`pushbackNote`、`metaLineOf`）各自直接测。
 */
import { describe, expect, it } from "vitest";

import type { Harness } from "@/lib/agent/harness";
import type { Msg } from "@/lib/agent/json";
import type { Violation } from "@/lib/agent/rules";
import type { Snapshot } from "@/lib/research/fetch";
import { Ledger, type EvidenceDraft } from "@/lib/research/ledger";

import type { SubjectCard } from "./anchor";
import type { PlaybookEntry } from "./draft";
import { stripHooks } from "./anchor-gate";
import type { Block, ReportBlocks } from "./blocks/schema";
import type { A4OutlineSection, A4ReportInput } from "./prompt";
import type { PlannedProposition } from "./plan";
import { reviewPlaybook, type Merged } from "./reconcile";
import { CLOSING_RESERVE_MS, COST } from "./deadline";
import {
  assignDims,
  cardBrief,
  loadBearingUnverified,
  mergedFor,
  metaLineOf,
  playbookOutline,
  pushbackNote,
  sinkVerdict,
  writeStaged,
} from "./stage-write";

/* -------------------------------------------------------------------------- */
/* 夹具                                                                        */
/* -------------------------------------------------------------------------- */

/** 这两句是断言用的记号：它们只出现在合并稿里，出现在提示词里就说明递到了。 */
const D1_BODY = "需求侧本季度回落约两成，回落集中在换机那一头。";
const D8_LOAD_BEARING = "那条产线的爬坡良率决定中尺寸接不接得到单。";

const merged: Merged = {
  thesis: "对完账之后的那句总判断：胜负手在中尺寸。",
  sections: [
    { dim: "D1", thesis: "需求这一维的论点", body: D1_BODY, tags: ["E*", "P"] },
    { dim: "D8", thesis: "落回主体这一维的论点", body: D8_LOAD_BEARING, tags: ["P!"] },
  ],
  changes: [
    { assertion: D1_BODY, from: "P", to: "E*", state: "证实", evidenceIds: ["E1"] },
    { assertion: D8_LOAD_BEARING, from: "P", to: "P!", state: "未验证", evidenceIds: [] },
  ],
  bad: [],
};

const card: SubjectCard = {
  subject: "某面板公司",
  segments: [{ name: "手机面板", weight: "七成", lifecycle: "投入期" }],
  projects: [
    { name: "那条 AMOLED 产线", investment: "两百亿", onlineAt: "2027", techRoute: "光刻类", heavy: true },
  ],
  inward: false,
  decision: false,
  customers: "整机厂",
  website: "",
  industry: "中尺寸显示面板",
  window: "当前时点 ± 未来 3 年",
};

const material: A4ReportInput = {
  issueId: "ISS-TEST",
  title: "这家公司所处的行业",
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  judgments: [],
  companyContext: "（本次无公司上下文）",
  cognitive: "",
  evidencePack: "",
  unresolved: "",
};

const prop = (id: string, dimension: string): PlannedProposition =>
  ({
    id,
    dimension,
    statement: `${id} 那条命题`,
    requiredEvidence: "机构数据",
    queries: [`${id} q`],
    counterQueries: [`${id} 反`],
    sourceKinds: ["行业机构"],
    material: true,
    freshnessUrgent: false,
    extraRoundsCap: 1,
  }) as PlannedProposition;

const props = [prop("D1-P1", "D1"), prop("D8-P1", "D8")];

const URL_A = "https://stats.example.gov.cn/a";
const BODY_A = "据国家某局，需求侧本季度回落约两成。另据同一份公报，供给侧同期没有同样的回落。";

const snap: Snapshot = {
  url: URL_A,
  title: "某局季度公报",
  text: BODY_A,
  contentHash: "h-a",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  truncated: false,
};

const evidence = (over: Partial<EvidenceDraft>): EvidenceDraft => ({
  propositionId: "D1-P1",
  claim: "需求侧本季度回落约两成",
  exactQuote: "需求侧本季度回落约两成",
  url: URL_A,
  supportRelation: "supports",
  evidenceType: "statement",
  authorityClass: "official_statistics",
  ...over,
});

/** 两条证据：E1 挂 D1-P1，E2 挂 D8-P1。 */
const ledgerOf = (): Ledger => {
  const l = new Ledger();
  l.archive([snap]);
  for (const d of [
    evidence({}),
    evidence({
      propositionId: "D8-P1",
      claim: "供给侧同期没有同样的回落",
      exactQuote: "供给侧同期没有同样的回落",
    }),
  ]) {
    const e = l.record(d);
    // 台账建不起来的话下面每一条断言都在测别的东西，所以这里直接炸。
    if (!e) throw new Error(`夹具没入账：${l.rejections.at(-1)?.why}`);
  }
  return l;
};

/* -------------------------------------------------------------------------- */
/* 假 Harness                                                                  */
/* -------------------------------------------------------------------------- */

type CallOpts = { wallMs?: number; maxTokens?: number; slot?: string };
type Recorded = { hint: string; messages: Msg[]; opts: CallOpts };

/**
 * `writeStaged` 只用到 `substep` / `note` / `callMessages` / `msLeft` 四件。
 *
 * `msLeft` 给 `Infinity` = 这一轮不设时间上限（`deadline.ts` 的 `room()` 对它恒为真）。
 * **少给这一栏的样子很难看懂**：`undefined >= 需要多久` 是 false，于是每一节都被判成
 * 「时间不够」，整份报告只剩收口那一段，而屏幕上不会有任何一处报错。
 */
const fakeHarness = (
  reply: (hint: string, messages: Msg[]) => string,
  /**
   * 这一轮还剩多少 —— **每次读都算一遍**，所以它可以在跑的中途变小。
   * 时间用完那几条用例要它：`msLeft` 写成常量的话，「等到一半发现来不及了」演不出来。
   */
  msLeft: () => number = () => Number.POSITIVE_INFINITY
): { h: Harness; calls: Recorded[]; notes: Record<string, unknown>[] } => {
  const calls: Recorded[] = [];
  const notes: Record<string, unknown>[] = [];
  const h = {
    get msLeft() {
      return msLeft();
    },
    substep: () => {},
    note: (label: string, detail: Record<string, unknown> = {}) => {
      notes.push({ label, ...detail });
    },
    /*
     * **记完账之后要真的让出一次**，再去算回复。
     *
     * 上一版是同步返回的（push 完当场 `reply(...)`），于是「发出去」和「回来」压在同一拍
     * 里 —— 几节并发发出去的时候，第一次的回复在第二次发出去之前就算完了。产物一模一样，
     * 但**并发在这个替身上观察不到**：串行和并发跑出来的记录长得一样，于是「几节一波并发
     * 写」那一条测不出退回串行（而退回串行是多几节的时间 —— 实测一节 423 秒，这一轮的全部
     * 余量只有 2.7 分钟）。
     *
     * 一个 `await` 就够：它把这一次的剩余部分推进微任务队列，同一波里的别几次因此能先把
     * 自己记进账。这也更像真的那一次调用 —— 那一次要过网络，绝不会同步回来。
     */
    callMessages: async (_label: string, messages: Msg[], opts?: unknown, _extra?: unknown, hint?: string) => {
      calls.push({ hint: hint ?? "", messages, opts: (opts ?? {}) as CallOpts });
      await Promise.resolve();
      return { text: reply(hint ?? "", messages) };
    },
  };
  return { h: h as unknown as Harness, calls, notes };
};

/**
 * 某一次调用里递过去的全部 user 文本。断言「递没递进去」看的就是它。
 *
 * **分节那几次的 content 是分块的**（缓存断点打在 `stable` 末尾），所以要摊平 —— 直接
 * `join` 出来的是 `[object Object]`，而那样的话「证据包里有没有这一条」这类断言恒为假，
 * 却又不报错，只是永远测不到东西。
 */
const userText = (calls: Recorded[], hint: string, nth = 0): string => {
  const hit = calls.filter((c) => c.hint === hint)[nth];
  if (!hit) throw new Error(`没有第 ${nth + 1} 次 ${hint} 调用（实到：${calls.map((c) => c.hint).join("、")}）`);
  return hit.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join("\n")))
    .join("\n");
};

const outlineJson = (sections: { id: string; ids: string[] }[]): string =>
  JSON.stringify({
    thesis_draft: "总判断的草案",
    sections: sections.map((s) => ({
      id: s.id,
      title: `${s.id} 那一节`,
      question: `${s.id} 问的是什么`,
      evidence_ids: s.ids,
      expected_blocks: ["prose", "judgment"],
      min_blocks: 2,
    })),
    unassigned: [],
  });

/** 一节交回来的两个块。`hooks` 那一栏是摘锚点那几条断言的落点。 */
const sectionJsonl = (hooks: string[]): string =>
  [
    JSON.stringify({
      type: "prose",
      heading: "这一节说得出什么",
      md: "这一段只讲机制，不写任何数。\n\n机制本身不依赖这一轮的外部材料。",
    }),
    JSON.stringify({
      type: "judgment",
      claim: "这一件由那条产线的爬坡进度决定",
      confidence: "初步提示",
      direction: "限定",
      reasoningSummary: "折旧从投产起计而收入要等认证，这个时间差由爬坡进度决定。",
      upgradeCondition: "拿到那条产线的爬坡良率区间",
      falsifyCondition: "投产时点推迟到分析时间窗之外",
      evidenceRefs: ["E1"],
      internalValidationHooks: hooks,
    }),
  ].join("\n");

const CLOSING_JSONL = [
  JSON.stringify({
    type: "report_meta",
    title: "中尺寸的良率经济性是这一行下一段的胜负手",
    confidence: "初步提示",
    dataCutoff: "2026-08-20",
  }),
  JSON.stringify({
    type: "verdict_banner",
    text: "更站得住的读法是：位置由那条产线的爬坡良率决定。",
    confidence: "初步提示",
    boundary: "只对中尺寸这一段成立。",
  }),
  JSON.stringify({
    heading: "这一份用到的材料",
    type: "evidence_list",
    items: [
      {
        id: "E1",
        claim: "需求侧本季度回落约两成",
        sourceName: "某局季度公报",
        sourceType: "官方统计",
        updateDirection: { target: "需求这一维", effect: "强化" },
      },
    ],
  }),
].join("\n");

/** 大纲一份、每节一份、收口一份；返修那一次回空串（走「留上一稿」那一支）。 */
const canned =
  (o: { outline: string; hooks?: string[] }) =>
  (hint: string): string => {
    switch (hint) {
      case "a4.layer.outline":
        return o.outline;
      case "a4.layer.section":
        return sectionJsonl(o.hooks ?? ["这条产线的爬坡良率记录"]);
      case "a4.layer.closing":
        return CLOSING_JSONL;
      default:
        return "";
    }
  };

const run = async (o: {
  outline: string;
  hooks?: string[];
  pushback?: Violation[];
  stripAnchors?: (report: ReportBlocks) => Promise<{ removed: string[] }>;
  /**
   * 换掉某几次调用的回复（`fallback` 是罐头那一份）。要测「某一节砸了」就在这里抛 ——
   * 假 `Harness` 是在记完账之后才算回复的，所以砸掉那一次照样进 `calls`。
   *
   * 第三个参数是**到这一刻为止的调用记录**。要它是为了能观察并发：算这一次回复的时候
   * 「已经发出去几次」，串行和并发给出的数不一样（1、2、3、4 对 1、4、4、4）。
   */
  reply?: (hint: string, fallback: string, calls: readonly Recorded[]) => string;
  /** 默认是两条证据那一份台账。给空台账是为了让「引了台账里没有的编号」成为唯一那条 p0。 */
  ledger?: Ledger;
  /** 决策题：主体卡标 decision，草稿的候选路线递进去。 */
  playbook?: PlaybookEntry[];
  /** 换掉那份合并稿（策略对账那几条用例要拿它带 `strategies`）。 */
  merged?: Merged;
  /** 这一轮还剩多少毫秒。不给 = 不限时。 */
  msLeft?: () => number;
}) => {
  const base = canned(o);
  const { h, calls, notes } = fakeHarness(
    (hint) => (o.reply ? o.reply(hint, base(hint), calls) : base(hint)),
    o.msLeft
  );
  const ledger = o.ledger ?? ledgerOf();
  const written = await writeStaged({
    h,
    material,
    card: o.playbook ? { ...card, decision: true } : card,
    merged: o.merged ?? merged,
    ...(o.playbook ? { playbook: o.playbook } : {}),
    props,
    ledger,
    verdicts: [],
    dims: ["D1", "D8"],
    lane: () => ({ model: "v2", short: "深研 v2", durationS: 0 }),
    ...(o.pushback ? { pushback: o.pushback } : {}),
    ...(o.stripAnchors ? { stripAnchors: o.stripAnchors } : {}),
  });
  return { written, calls, notes };
};

/* -------------------------------------------------------------------------- */
/* 折成一段话的那几个纯函数                                                     */
/* -------------------------------------------------------------------------- */

describe("mergedFor —— 合并稿折成一段话", () => {
  it("只折要的那几维，别的一个字不带", () => {
    const only8 = mergedFor(merged, ["D8"]);
    expect(only8).toContain(D8_LOAD_BEARING);
    expect(only8).not.toContain(D1_BODY);
  });

  it("标签原样带着 —— 写的人要分得出手上这句是哪一档", () => {
    const text = mergedFor(merged, ["D1", "D8"]);
    expect(text).toContain("这一维的标签：P!");
    expect(text).toContain("E*");
  });

  it("变更日志按断言原文回挂到它出现的那一维", () => {
    expect(mergedFor(merged, ["D8"])).toContain("［P!／未验证］");
    expect(mergedFor(merged, ["D1"])).toContain("［E*／证实］");
    // 挂不上的那几条不硬塞进某一维 —— 塞错维度比不递更坏。
    const orphan: Merged = { ...merged, changes: [{ ...merged.changes[0], assertion: "被改写过的断言" }] };
    expect(mergedFor(orphan, ["D1", "D8"])).not.toContain("被改写过的断言");
  });

  it("被推翻（X）和被修正的旧说法不递 —— 递了分节就会写「我们之前以为」（2026-09-04）", () => {
    const withOld: Merged = {
      ...merged,
      changes: [
        ...merged.changes,
        { assertion: D1_BODY, from: "P", to: "X", state: "矛盾", evidenceIds: ["E2"] },
        { assertion: D8_LOAD_BEARING, from: "P", to: "E*", state: "修正", evidenceIds: ["E3"] },
      ],
    };
    const text = mergedFor(withOld, ["D1", "D8"]);
    expect(text).not.toContain("／矛盾］");
    expect(text).not.toContain("／修正］");
    expect(text).toContain("［E*／证实］");
    expect(text).toContain("［P!／未验证］");
  });

  it("一维都不沾时返回空串（这一节就不带这一段）", () => {
    expect(mergedFor(merged, ["D3"])).toBe("");
    expect(mergedFor(merged, [])).toBe("");
  });
});

describe("loadBearingUnverified —— 承重但没验证的那几条", () => {
  it("只挑降到 P! 的，收口那一次的待核清单从这里来", () => {
    expect(loadBearingUnverified(merged)).toEqual([D8_LOAD_BEARING]);
  });

  it("一条 P! 都没有时是空的", () => {
    expect(loadBearingUnverified({ ...merged, changes: [merged.changes[0]] })).toEqual([]);
  });
});

describe("assignDims —— 每一节对着哪几维", () => {
  const section = (id: string, evidenceIds: string[]): A4OutlineSection => ({
    id,
    title: `${id} 那一节`,
    question: "问的是什么",
    evidenceIds,
    expectedBlocks: [],
    minBlocks: 2,
  });
  const entries = [
    { id: "E1", propositionId: "D1-P1" },
    { id: "E2", propositionId: "D8-P1" },
  ];

  it("顺着「这一节的证据 → 它验的命题 → 那条命题的维度」认", () => {
    const out = assignDims({
      sections: [section("S1", ["E1"]), section("S2", ["E2"])],
      entries,
      props,
      dims: ["D1", "D8"],
    });
    expect(out.get("S1")).toEqual(["D1"]);
    expect(out.get("S2")).toEqual(["D8"]);
  });

  it("一条证据都没分到的那一节拿还没派出去的维度", () => {
    const out = assignDims({
      sections: [section("S1", []), section("S2", ["E2"])],
      entries,
      props,
      dims: ["D1", "D8"],
    });
    expect(out.get("S1")).toEqual(["D1", "D8"]);
  });

  it("剩下的维度全归最后一节 —— 八维的内容一条都不许在成稿这一步蒸发", () => {
    const out = assignDims({
      sections: [section("S1", ["E1"])],
      entries,
      props,
      dims: ["D1", "D8"],
    });
    expect(out.get("S1")).toEqual(["D1", "D8"]);
  });

  it("抽取那一步交回的命题号不在计划里时，那一节不认它", () => {
    const out = assignDims({
      sections: [section("S1", ["E1"]), section("S2", ["E2"])],
      entries: [{ id: "E1", propositionId: "P1" }, { id: "E2", propositionId: "D8-P1" }],
      props,
      dims: ["D1", "D8"],
    });
    // S1 分不出维度（`P1` 不在计划里）→ 拿还没派出去的那两维。S2 自己认得出 D8，所以照拿
    // 不看 `handed` —— 认得出的那一节永远拿它自己那几维，重复递给两节也不减。宁可重复，
    // 不可蒸发：这一段的默认值是「多递一份」而不是「少写一维」。
    expect(out.get("S1")).toEqual(["D1", "D8"]);
    expect(out.get("S2")).toEqual(["D8"]);
  });
});

describe("cardBrief —— 主体卡折成一段话", () => {
  it("行业定义和权重过线的项目都在里面（A4-N05 要靠它）", () => {
    const text = cardBrief(card);
    expect(text).toContain("中尺寸显示面板");
    expect(text).toContain("那条 AMOLED 产线（权重过线）");
  });

  it("空卡也折得出来，不抛", () => {
    const text = cardBrief({
      subject: "",
      segments: [],
      projects: [],
      inward: false,
      decision: false,
      customers: "",
      website: "",
      industry: "",
      window: "",
    });
    expect(text).toContain("（没识别出主体）");
  });
});

describe("pushbackNote —— 打回原因折成一段话", () => {
  const v = (rule: string, severity: "p0" | "p1"): Violation => ({ rule, severity, message: `${rule} 那条` });

  it("有 p0 时只列 p0 —— 别拿 p1 把要改的那几条冲淡", () => {
    const note = pushbackNote([v("A4-N01", "p0"), v("A4-B08", "p1")]);
    expect(note).toContain("A4-N01");
    expect(note).not.toContain("A4-B08");
  });

  it("全是 p1 时照样列出来", () => {
    expect(pushbackNote([v("A4-B08", "p1")])).toContain("A4-B08");
  });

  it("一条都没有时是空串（第一遍不带这一段）", () => {
    expect(pushbackNote([])).toBe("");
  });
});

describe("metaLineOf —— 找元数据那一行", () => {
  it("挑出 report_meta 那一行，坏行跳过", () => {
    const text = ["不是 JSON 的一行", "{坏的 JSON", JSON.stringify({ type: "prose", md: "x" }), JSON.stringify({ type: "report_meta", title: "t" })].join("\n");
    expect(metaLineOf(text)).toContain("report_meta");
  });

  it("没有那一行时返回空串", () => {
    expect(metaLineOf(JSON.stringify({ type: "prose", md: "x" }))).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* 递给模型的那几条消息                                                         */
/* -------------------------------------------------------------------------- */

describe("合并稿和主体卡真的递给了写报告的那几次", () => {
  const outline = outlineJson([
    { id: "S1", ids: ["E1"] },
    { id: "S2", ids: ["E2"] },
  ]);

  it("大纲那一次拿到全部维度的合并稿、主体卡，和标签怎么用那句话", async () => {
    const { calls } = await run({ outline });
    const text = userText(calls, "a4.layer.outline");
    expect(text).toContain(D1_BODY);
    expect(text).toContain(D8_LOAD_BEARING);
    expect(text).toContain("中尺寸显示面板");
    // 这一版最贵的那条规矩必须跟着递过去，不然「留着内容降标签」在写的时候没人知道。
    expect(text).toContain("缺证据不是删内容的理由，只是降标签的理由");
  });

  it("分节那一次只拿这一节对着的那几维 —— 整份递过去等于每节都把八维写一遍", async () => {
    const { calls } = await run({ outline });
    const s1 = userText(calls, "a4.layer.section", 0);
    const s2 = userText(calls, "a4.layer.section", 1);
    expect(s1).toContain(D1_BODY);
    expect(s1).not.toContain(D8_LOAD_BEARING);
    expect(s2).toContain(D8_LOAD_BEARING);
    expect(s2).not.toContain(D1_BODY);
  });

  it("收口那一次拿到对完账的总判断，和 P! 那几条待核清单", async () => {
    const { calls } = await run({ outline });
    const text = userText(calls, "a4.layer.closing");
    expect(text).toContain("胜负手在中尺寸");
    expect(text).toContain("待核清单必须逐条收下");
    expect(text).toContain(D8_LOAD_BEARING);
  });

  it("打回那一轮把原因递下去 —— 不带原因等于让它重写一份不知道哪里错了的报告", async () => {
    const { calls } = await run({
      outline,
      pushback: [{ rule: "A4-N01", severity: "p0", message: "总判断没有立场" }],
    });
    for (const hint of ["a4.layer.outline", "a4.layer.section", "a4.layer.closing"]) {
      expect(userText(calls, hint)).toContain("上一稿在出口对账上没过这几条");
      expect(userText(calls, hint)).toContain("总判断没有立场");
    }
  });

  it("第一遍不带打回那一段", async () => {
    const { calls } = await run({ outline });
    expect(userText(calls, "a4.layer.outline")).not.toContain("上一稿在出口对账上没过");
  });

  it("决策题（R-11）：对完账的行动建议递给大纲、每一节和收口", async () => {
    const { calls } = await run({ outline, playbook: PLAYBOOK, merged: MERGED_KEEP });
    for (const hint of ["a4.layer.outline", "a4.layer.section", "a4.layer.closing"]) {
      expect(userText(calls, hint)).toContain("已经过 N4 对账");
      expect(userText(calls, hint)).toContain("首访只谈验收口径，不报价");
    }
    // 分析题不带这一整段。（决策题那几段 system 提示词归 §3.D 那条线，断言在 prompt.test.ts。）
    const plain = await run({ outline });
    expect(userText(plain.calls, "a4.layer.outline")).not.toContain("已经过 N4 对账");
  });
});

/* -------------------------------------------------------------------------- */
/* 行动骨架必须经过对账（§3.C 主修点）                                           */
/* -------------------------------------------------------------------------- */

/**
 * ## 这一组测的是数据流，不是措辞
 *
 * 上一版 `StageWriteInput.playbook` 的注释明写「不经 N4 对账」，而 `pipeline.ts:1237` 递的是
 * `draft.playbook`。ISS-239（`RUN-A4-mtqpegne-4`，2026-09-07）因此出现了这一版要修的那件事：
 * 对账已经把「采购只为当期成本 KPI 买单」改成未获证实、并补上「经营现金流已改善」，最终报告
 * 的强命令一条没动。
 *
 * 所以下面每一条断的都是**那几次出稿调用的上下文里到底有什么**，不是提示词里有没有多一句
 * 「注意核验」。
 */
const KPI = "客户采购只为当期成本 KPI 买单";
const OLD_BODY = "先报价会把谈判拉到成本上，四步顺序不能换，只有工艺负责人能定验收。";

const PLAYBOOK: PlaybookEntry[] = [
  {
    heading: "首访只谈验收口径，不报价",
    body: OLD_BODY,
    assertions: [{ text: KPI, tag: "P", confidence: "高", timeSensitive: true, loadBearing: true, answerIn: "要问对方" }],
  },
];

/** 前提被证实、N4 判「保留」—— 这一条路线原样成立。 */
const MERGED_KEEP: Merged = {
  ...merged,
  changes: [...merged.changes, { assertion: KPI, from: "P", to: "E*", state: "证实", evidenceIds: ["E1"] }],
  strategies: [
    { strategyId: "S1", kind: "保留", factChange: "证实", evidenceIds: ["E1"], why: "站得住", advice: "", conditions: "" },
  ],
};

describe("N5 只读 N4 更新过的建议", () => {
  const outline = outlineJson([{ id: "S1", ids: ["E1", "E2"] }]);

  it("承重前提被证伪 → 三次调用都读不到旧主张当有效建议，读到的是改后那一句", async () => {
    const falsified: Merged = {
      ...merged,
      changes: [...merged.changes, { assertion: KPI, from: "P", to: "X", state: "矛盾", evidenceIds: ["E2"] }],
      strategies: [
        {
          strategyId: "S1",
          kind: "改向",
          factChange: "采购动机未获证实，经营现金流已改善",
          evidenceIds: ["E2"],
          why: "按成本口径谈会谈错对象",
          advice: "先向经营负责人确认采购动因，首访不锁定验收口径",
          conditions: "只在能约到经营负责人时成立",
        },
      ],
    };
    const { calls, written } = await run({ outline, playbook: PLAYBOOK, merged: falsified });

    for (const hint of ["a4.layer.outline", "a4.layer.section", "a4.layer.closing"]) {
      const text = userText(calls, hint);
      expect(text).toContain("先向经营负责人确认采购动因");
      // **旧草稿的论证一个字都不递** —— ISS-239 证明了只要它在上下文里就会被照抄。
      expect(text).not.toContain(OLD_BODY);
      expect(text).not.toContain("四步顺序不能换");
      // 被推翻的那条前提要显式标出来 —— 它不能继续给任何一句建议承重。
      expect(text).toContain("已被推翻、不能再承重的前提");
      expect(text).toContain(KPI);
    }
    expect(written.strategyReview.status).toBe("已复核");
    expect(written.strategyReview.effective[0].advice).not.toContain("只谈验收口径");
  });

  it("N4 判「保留」且前提证实 → 主张照旧是有效建议（那本身就是 N4 给的更新）", async () => {
    const { calls, written } = await run({ outline, playbook: PLAYBOOK, merged: MERGED_KEEP });
    expect(userText(calls, "a4.layer.section")).toContain("首访只谈验收口径，不报价");
    expect(written.strategyReview.effective).toHaveLength(1);
    expect(written.delivery.readiness).toBe("具备决策条件");
  });

  it("N4 一条策略更新都没给 → 标「策略复核未完成」，不恢复旧建议来凑完整", async () => {
    // 合并稿上没有 `strategies` 那一栏 —— `pipeline.ts` 的 `mergedFromDraft` 退出来的就是这个形状。
    const { calls, written } = await run({ outline, playbook: PLAYBOOK, merged });
    const text = userText(calls, "a4.layer.section");

    expect(written.strategyReview.status).toBe("未复核");
    expect(written.strategyReview.effective).toHaveLength(0);
    // 旧建议不许被恢复成有效建议。
    expect(text).not.toContain(OLD_BODY);
    expect(text).toContain("以下是历史草稿，**不是建议**");
    expect(text).toContain("策略复核未完成");
    expect(text).toContain("不是可以直接下达的行动方案");
    // 缺口清单里也要有 —— 提示词里的东西事后一栏都读不到。
    expect(written.notes.join("\n")).toContain("策略复核未完成");
    // 交付：三节写全了也不算「具备决策条件」。
    expect(written.delivery.completeness).toBe("完整");
    expect(written.delivery.readiness).toBe("可供讨论");
    expect(written.delivery.why.join("")).toContain("一条都没经过 N4 复核");
  });

  it("没证据但路线仍可低成本探索 → 条件性建议留着，不退成无条件命令，也不只剩拒答", async () => {
    const unverified: Merged = {
      ...merged,
      changes: [...merged.changes, { assertion: KPI, from: "P", to: "P!", state: "未验证", evidenceIds: [] }],
      strategies: [
        {
          strategyId: "S1",
          kind: "待验证",
          factChange: "采购动机未获证实",
          evidenceIds: [],
          why: "低成本先问一句就能定路",
          advice: "首访先问清采购动因，再决定谈不谈验收口径",
          conditions: "",
        },
      ],
    };
    const { calls, written } = await run({ outline, playbook: PLAYBOOK, merged: unverified });
    const text = userText(calls, "a4.layer.section");

    // 建议还在（不是拒答）……
    expect(text).toContain("首访先问清采购动因");
    // ……但必须带着条件（不是无条件命令）。N4 没写条件时按未验证的前提代拟一句。
    expect(text).toContain("成立条件：");
    expect(text).toContain("没有得到证据支持");
    expect(text).toContain("未获验证的承重前提（写成条件，不写成事实）");
    expect(written.strategyReview.effective).toHaveLength(1);
    expect(written.notes.join("\n")).toContain("不得把它写成无条件命令");
  });

  it("行业题不带这一整段 —— 没有候选路线就是「不适用」，不报一条缺口", async () => {
    const { written } = await run({ outline });
    expect(written.strategyReview.status).toBe("不适用");
    expect(written.notes.join("\n")).not.toContain("策略对账：");
  });
});

/* -------------------------------------------------------------------------- */
/* 排结构塌了：拿 N1 的决策骨架当大纲（ISS-240）                                  */
/* -------------------------------------------------------------------------- */

/**
 * ## 这一组钉的是一次真塌方，不是一个假设
 *
 * `RUN-A4-mtqtenit-2`（2026-09-07）跑了 24 分 20 秒：轮到排结构时只剩 456 秒，把「一节 +
 * 收口 + 两次锚点检查」的位置留出去之后这一次只分到 46 秒，网宿网关等到 45 秒超时。然后
 * 一路塌下去 —— 没有大纲 → 折成一节 → 那一节也没时间写 → **正文 1 块、附录 5 块、0/1 节，
 * 取回来的 24 条证据用上 0 条、弃用 0 条、没交代 24 条**。
 *
 * 预算下限那一刀在 `deadline.ts` 已经落过，但那只是让饿死的概率变小。这里改的是兜底本身：
 * **失败代价严重不对等**，收口被压短只是话少一点，结构没出来就是一份没有正文的报告。
 */
const ROUTES = [
  { heading: "先把验收口径谈定，再谈价", premise: "客户采购只为当期成本 KPI 买单" },
  { heading: "中尺寸这条线这一年先不扩产", premise: "中尺寸的爬坡良率一年内到不了线" },
  { heading: "把那条产线的产能先包给整机厂", premise: "整机厂愿意签两年包销" },
];

const PLAYBOOK3: PlaybookEntry[] = ROUTES.map((r) => ({
  heading: r.heading,
  body: `${r.heading}：N1 凭既有知识写的那段旧论证。`,
  assertions: [
    { text: r.premise, tag: "P", confidence: "高", timeSensitive: true, loadBearing: true, answerIn: "要问对方" },
  ],
}));

/** 三条前提都被证实，三条路线 N4 都给了更新 —— `status` 是「已复核」，三条全是有效建议。 */
const MERGED3: Merged = {
  ...merged,
  changes: [
    ...merged.changes,
    ...ROUTES.map((r) => ({
      assertion: r.premise,
      from: "P" as const,
      to: "E*" as const,
      state: "证实" as const,
      evidenceIds: ["E1"],
    })),
  ],
  strategies: [
    { strategyId: "S1", kind: "保留", factChange: "经查仍成立", evidenceIds: ["E1"], why: "站得住", advice: "", conditions: "" },
    {
      strategyId: "S2",
      kind: "改向",
      factChange: "良率进度已可核",
      evidenceIds: [],
      why: "扩产窗口比原判断晚一年",
      advice: "先按不扩产准备，季度末拿良率区间复核一次",
      conditions: "",
    },
    {
      strategyId: "S3",
      kind: "收窄",
      factChange: "包销意向只覆盖部分产能",
      evidenceIds: ["E9"],
      why: "整机厂只肯签三成",
      advice: "只把三成产能包给整机厂，其余留给现货",
      conditions: "",
    },
  ],
};

/** 排结构那一次直接抛 —— 网关 45 秒超时在这一层看到的就是这个。 */
const outlineDies = (hint: string, fallback: string): string => {
  if (hint === "a4.layer.outline") throw new Error("网关超时");
  return fallback;
};

describe("排结构没成时按 N1 的决策骨架分节", () => {
  const outline = outlineJson([{ id: "S1", ids: ["E1", "E2"] }]);

  it("骨架有 3 条有效建议 → 分成 3 节，标题就是那三句判断", async () => {
    const { calls, written } = await run({
      outline,
      playbook: PLAYBOOK3,
      merged: MERGED3,
      reply: outlineDies,
    });

    const sectionCalls = calls.filter((c) => c.hint === "a4.layer.section");
    expect(sectionCalls).toHaveLength(3);
    for (const [i, r] of ROUTES.entries()) {
      expect(userText(calls, "a4.layer.section", i)).toContain(r.heading);
    }
    // 折成一节那条老路一节都不许走 —— 它正是 ISS-240 里那份没有正文的报告的来源。
    expect(written.notes.join("\n")).not.toContain("已折成一节");
    expect(written.delivery.coreSections).toEqual({ written: 3, planned: 3 });
  });

  it("取回来的证据一条都不许落空：分不到具体某节的进最后一节", async () => {
    const { calls, written } = await run({
      outline,
      playbook: PLAYBOOK3,
      merged: MERGED3,
      reply: outlineDies,
    });

    // E1 按 N4 那条策略更新自己引的编号分给了第一节。
    expect(userText(calls, "a4.layer.section", 0)).toContain("原文引句：「需求侧本季度回落约两成」");
    // 第二节那条更新一条编号都没引 —— 它靠推理撑，不该凭空拿到别人的证据。
    expect(userText(calls, "a4.layer.section", 1)).not.toContain("原文引句：「");
    // 第三节那条引的 E9 不在本轮台账里，被剔掉；没人认领的 E2 补进最后一节。
    expect(userText(calls, "a4.layer.section", 2)).toContain("原文引句：「供给侧同期没有同样的回落」");
    expect(written.notes.join("\n")).toContain("已补进最后一节");
    expect(written.notes.join("\n")).toContain("E2");
  });

  it("缺陷清单要说出来：这一份的章节是骨架毛坯，不是模型排的结构", async () => {
    const { written } = await run({
      outline,
      playbook: PLAYBOOK3,
      merged: MERGED3,
      reply: outlineDies,
    });
    const text = written.notes.join("\n");
    expect(text).toContain("排结构那一次没成，已按 N1 的决策骨架分成 3 节");
    expect(text).toContain("不是模型排的结构");
    // 抛出来的那一次也要留原因，否则下一轮无从查起。
    expect(text).toContain("排结构那一次没成，按 N1 的决策骨架往下走：网关超时");
    // 三条都复核过时不该多那半句。
    expect(text).not.toContain("策略复核只做了一部分");
  });

  it("复核只做了一部分时那一句要写清楚 —— 这几节的题目来自没复核完的候选路线", async () => {
    const partial: Merged = { ...MERGED3, strategies: [MERGED3.strategies![0], MERGED3.strategies![1]] };
    const { written } = await run({ outline, playbook: PLAYBOOK3, merged: partial, reply: outlineDies });

    expect(written.strategyReview.status).toBe("部分复核");
    const text = written.notes.join("\n");
    expect(text).toContain("已按 N1 的决策骨架分成 2 节");
    expect(text).toContain("策略复核只做了一部分");
    expect(text).toContain("不得把它们写成可以直接下达的行动");
    expect(written.delivery.readiness).toBe("可供讨论");
  });

  it("骨架也是空的（N4 一条都没复核）→ 退回「折成一节」，行为一个字不变", async () => {
    // `merged` 上没有 `strategies`，所以 `reviewPlaybook` 判「未复核」、有效建议为零。
    const { calls, written } = await run({ outline, playbook: PLAYBOOK, reply: outlineDies });

    expect(written.strategyReview.effective).toHaveLength(0);
    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(1);
    const text = written.notes.join("\n");
    expect(text).toContain("排结构那一次没成，折成一节往下走：网关超时");
    expect(text).toContain("已折成一节，涵盖全部证据");
    expect(text).not.toContain("决策骨架");
  });

  it("行业题这一支逐字不变 —— 没有候选路线就没有毛坯可用", async () => {
    const { calls, written } = await run({ outline, reply: outlineDies });

    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(1);
    expect(written.notes).toContain("排结构那一次没成，折成一节往下走：网关超时");
    expect(written.notes).toContain("大纲那一次没有交出可用的章节，已折成一节，涵盖全部证据。");
    expect(written.notes.join("\n")).not.toContain("骨架");
    // 折成一节那一节照旧涵盖全部编号。
    const s1 = userText(calls, "a4.layer.section", 0);
    expect(s1).toContain("原文引句：「需求侧本季度回落约两成」");
    expect(s1).toContain("原文引句：「供给侧同期没有同样的回落」");
  });

  it("模型真交出了结构时骨架一节都不用 —— 毛坯只在精修失败时顶上", async () => {
    const { calls, written } = await run({ outline, playbook: PLAYBOOK3, merged: MERGED3 });
    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(1);
    expect(written.notes.join("\n")).not.toContain("决策骨架");
  });
});

describe("playbookOutline —— 复核完的候选路线折成毛坯大纲", () => {
  const review = reviewPlaybook({ playbook: PLAYBOOK3, merged: MERGED3 });

  it("标题用 heading（它本来就是一句判断），问题从建议和成立条件推出来", () => {
    const { sections } = playbookOutline({ review, packIds: ["E1", "E2"] });
    expect(sections.map((s) => s.title)).toEqual(ROUTES.map((r) => r.heading));
    expect(sections[1].question).toContain("先按不扩产准备");
    expect(sections[1].question).toContain("什么会推翻它");
    // 一节一个块就答完了它那一问（决策题那一档，ISS-238）。
    expect(sections.map((s) => s.minBlocks)).toEqual([1, 1, 1]);
  });

  it("台账里没有的编号不认；一条有效建议都没有时交空的（调用方据此退回「折成一节」）", () => {
    const { sections } = playbookOutline({ review, packIds: ["E1", "E2"] });
    expect(sections[2].evidenceIds).toEqual([]);
    const none = playbookOutline({ review: { ...review, effective: [] }, packIds: ["E1"] });
    expect(none).toEqual({ sections: [], note: "" });
  });

  it("N4 代拟的成立条件跟着进这一节的问题 —— 条件是建议成立的范围，不是脚注", () => {
    const conditioned = reviewPlaybook({
      playbook: [PLAYBOOK3[0]],
      merged: {
        ...merged,
        changes: [
          ...merged.changes,
          { assertion: ROUTES[0].premise, from: "P", to: "P!", state: "未验证", evidenceIds: [] },
        ],
        strategies: [
          {
            strategyId: "S1",
            kind: "待验证",
            factChange: "采购动机未获证实",
            evidenceIds: [],
            why: "低成本先问一句就能定路",
            advice: "首访先问清采购动因",
            conditions: "",
          },
        ],
      },
    });
    const { sections } = playbookOutline({ review: conditioned, packIds: ["E1"] });
    expect(sections[0].question).toContain("成立条件：");
    expect(sections[0].question).toContain("没有得到证据支持");
  });
});

/* -------------------------------------------------------------------------- */
/* 时间与完整性（§3.E）                                                          */
/* -------------------------------------------------------------------------- */

describe("每次调用的墙上预算", () => {
  const outline = outlineJson([{ id: "S1", ids: ["E1", "E2"] }]);

  /*
   * §3.E：「每次调用预算不得超过剩余总时长减去收口保留」。上一版每一次调用递下去的是
   * `harness` 那句 `timeoutMs: this.msLeft` —— 整轮剩下的全部时间，于是一次卡住的分节调用
   * 可以把收口那一次的位置一并等掉（ISS-239 的 S1/S2 各等满 420 秒）。
   */
  it("分节那一次留出收口的位置", async () => {
    const LEFT = 20 * 60_000;
    const { calls } = await run({ outline, msLeft: () => LEFT });
    const section = calls.find((c) => c.hint === "a4.layer.section");
    expect(section?.opts.wallMs).toBe(LEFT - CLOSING_RESERVE_MS);
    expect(section?.opts.wallMs).toBeLessThan(LEFT);
  });

  it("暖缓存那一次还要按自己那一档估值封顶 —— 它的产物只有一个「好」字", async () => {
    const { calls } = await run({ outline, msLeft: () => 20 * 60_000 });
    expect(calls.find((c) => c.hint === "a4.layer.warm")?.opts.wallMs).toBe(COST.warm);
  });

  it("收口那一次只给锚点检查留位 —— 它本身就是别人让出来的那一段", async () => {
    const LEFT = 20 * 60_000;
    const { calls } = await run({ outline, msLeft: () => LEFT });
    expect(calls.find((c) => c.hint === "a4.layer.closing")?.opts.wallMs).toBe(LEFT - 2 * COST.anchorGate);
  });

  it("不限时的那一轮整个不带这个键 —— 递一个 Infinity 读起来像「永不超时」", async () => {
    const { calls } = await run({ outline });
    // 暖缓存那一次例外：它有自己那一档估值上限，跟这一轮限不限时无关。
    for (const c of calls.filter((x) => x.hint !== "a4.layer.warm")) {
      expect(c.opts.wallMs, c.hint).toBeUndefined();
    }
    expect(calls.find((c) => c.hint === "a4.layer.warm")?.opts.wallMs).toBe(COST.warm);
  });

  it("预热可以关掉：关了各节照写，缺口清单里留一句（不宣称它一定省钱）", async () => {
    process.env.TKOS_A4_WARM_CACHE = "0";
    try {
      const { calls, written } = await run({ outline });
      expect(calls.some((c) => c.hint === "a4.layer.warm")).toBe(false);
      expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(1);
      expect(written.notes.join("\n")).toContain("TKOS_A4_WARM_CACHE=0");
    } finally {
      delete process.env.TKOS_A4_WARM_CACHE;
    }
  });
});

describe("定稿闸：晚到的正文不覆盖已定稿的那一份", () => {
  it("已定稿之后不收，同一节收第二份也不收", () => {
    const have = new Set(["S1"]);
    expect(sinkVerdict({ sealed: false, have, id: "S2" })).toBe("收下");
    expect(sinkVerdict({ sealed: false, have, id: "S1" })).toBe("这一节已经有了");
    expect(sinkVerdict({ sealed: true, have, id: "S2" })).toBe("已定稿，不收");
    // 定稿闸压过「这一节还没有」——两条都不满足才收。
    expect(sinkVerdict({ sealed: true, have: new Set(), id: "S9" })).toBe("已定稿，不收");
  });
});

describe("核心章节超时：部分状态可见、无无限补写", () => {
  const outline = outlineJson([
    { id: "S1", ids: ["E1"] },
    { id: "S2", ids: ["E2"] },
  ]);

  /*
   * ISS-239 的形状：三节里两节超时，收口补了一段摘要。**补摘要不等于补齐核心论证** ——
   * 这一条钉的就是那两件事在数据上分得开。
   */
  it("一节超时、时间只够收口 → 不再补写，交付落「部分」，收口那一栏单独记", async () => {
    /*
     * 时间这样走：进门时够（一节 + 收口），第一波之后掉到只够收口。`roomForSections()` 于是
     * 拦下补写那一波 —— 这就是「失败后最多一次定点补写」的下限：一次都不补也是合法结果。
     */
    let phase = 0;
    let nth = 0;
    const { calls, written } = await run({
      outline,
      msLeft: () => (phase === 0 ? 20 * 60_000 : CLOSING_RESERVE_MS + 1000),
      reply: (hint, fallback) => {
        if (hint !== "a4.layer.section") return fallback;
        if (nth++ === 0) {
          // 这一节等满了自己那一档预算才被中止，而等的这段时间把补写那一波的位置也用掉了。
          phase = 1;
          throw new Error("那一次超时了");
        }
        return fallback;
      },
    });

    // 两节发出去，一节砸了，补写那一波没发 —— 一共就两次，不是无限重试。
    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(2);
    expect(written.notes.join("\n")).toContain("不再补写");

    expect(written.delivery.callsFinished).toBe(true);
    expect(written.delivery.completeness).toBe("部分");
    expect(written.delivery.coreSections).toEqual({ written: 1, planned: 2 });
    expect(written.delivery.closing).toBe(true);
    // 「收口交了」不许被读成「论证补齐了」。
    expect(written.delivery.why.join("")).toContain("那不等于缺的那几节的论证被补上了");
    expect(written.delivery.readiness).toBe("可供讨论");
  });

  it("补写那一波只有一次：补写里再砸一次也不排第三波", async () => {
    let nth = 0;
    const { calls, written } = await run({
      outline,
      reply: (hint, fallback) => {
        if (hint !== "a4.layer.section") return fallback;
        // S1 第一波砸、补写那一次再砸；S2 正常。
        const at = nth++;
        if (at === 0 || at === 2) return "";
        return fallback;
      },
    });
    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(3);
    expect(written.notes.join("\n")).toContain("补写那一次也没成");
    expect(written.delivery.completeness).toBe("部分");
  });

  it("补写复用同一份合并稿，未验证的那几条仍旧是 P!，不趁机升格", async () => {
    let nth = 0;
    const { calls } = await run({
      outline,
      reply: (hint, fallback) => (hint === "a4.layer.section" && nth++ === 0 ? "" : fallback),
    });
    // 第三次是 S1 的补写。标签口径和第一次一模一样 —— 复用已有证据不等于假设被验过了。
    const retry = userText(calls, "a4.layer.section", 2);
    expect(retry).toContain("缺证据不是删内容的理由，只是降标签的理由");
    expect(retry).toContain("`P!` 未验证但结论依赖它");
  });

  it("一节都没写成 → 交付落「失败」，不落「部分」", async () => {
    const { written } = await run({
      outline: outlineJson([{ id: "S1", ids: ["E1", "E2"] }]),
      reply: (hint, fallback) => (hint === "a4.layer.section" ? "" : fallback),
    });
    expect(written.delivery.completeness).toBe("失败");
    expect(written.delivery.coreSections).toEqual({ written: 0, planned: 1 });
  });
});

describe("证据替换要闭环（§3.C 最后一条）", () => {
  it("弃用理由点名的那条没进有效依据 → 记一句进缺口清单", async () => {
    /*
     * 造 ISS-239 那份账本：E2 写着「被更晚的 E3 替代」，而 E3 既没被正文引上、也没有自己的
     * 弃用理由 —— 它落在「没交代」那一列。这正是那一轮 E11／E12 的形状。
     */
    const three = ledgerOf();
    if (!three.record(evidence({ propositionId: "D8-P1", claim: "据同一份公报", exactQuote: "据同一份公报" }))) {
      throw new Error(`第三条没入账：${three.rejections.at(-1)?.why}`);
    }
    const withSwap = [
      sectionJsonl(["这条产线的爬坡良率记录"]),
      JSON.stringify({
        type: "evidence_usage",
        used: [],
        discarded: [{ id: "E2", reason: "用更晚的 E3 替代" }],
      }),
    ].join("\n");
    const { written } = await run({
      outline: outlineJson([{ id: "S1", ids: ["E1", "E2", "E3"] }]),
      ledger: three,
      reply: (hint, fallback) => (hint === "a4.layer.section" ? withSwap : fallback),
    });
    expect(written.notes.join("\n")).toContain("证据账本没闭环");
    expect(written.notes.join("\n")).toContain("没交代");
  });
});

/* -------------------------------------------------------------------------- */
/* 砸掉那一节的维度不许蒸发                                                     */
/* -------------------------------------------------------------------------- */

describe("某一节没写成，那一节重来一次（几节并发之后没有「下一节」可顺）", () => {
  /*
   * 2026-08-31 之前这里测的是「砸掉那一节的维度顺给下一节」。几节改成并发写之后没有
   * 「下一节」了，补法换成**那一节自己重来一次** —— 换得更结实：顺给下一节只是把那几维的
   * 材料多递一份、指望它顺手写两段，重来一次是那一节真的被写出来。
   *
   * 调用顺序：S1、S2 同一波发出去（S1 砸）→ S1 补写。
   */
  const outline = outlineJson([
    { id: "S1", ids: ["E1"] },
    { id: "S2", ids: ["E2"] },
  ]);

  it("抛了的那一节被重发一次，它那几维跟着它自己走", async () => {
    let nth = 0;
    const { calls, written } = await run({
      outline,
      reply: (hint, fallback) => {
        if (hint === "a4.layer.section" && nth++ === 0) throw new Error("那一次超时了");
        return fallback;
      },
    });
    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(3);
    // 补写那一次拿的是 S1 自己那几维 —— 不补的话这一维的先验内容和标签在这一轮里就没人写。
    expect(userText(calls, "a4.layer.section", 2)).toContain(D1_BODY);
    // 并发那一波里的 S2 只拿自己那一维，不替 S1 背。
    expect(userText(calls, "a4.layer.section", 1)).toContain(D8_LOAD_BEARING);
    expect(userText(calls, "a4.layer.section", 1)).not.toContain(D1_BODY);
    expect(written.notes.join("\n")).toContain("再试一次");
  });

  it("回来是空的那一节同样重发 —— 空回复和抛异常在产物上是一件事", async () => {
    let nth = 0;
    const { calls } = await run({
      outline,
      reply: (hint, fallback) => (hint === "a4.layer.section" && nth++ === 0 ? "" : fallback),
    });
    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(3);
    expect(userText(calls, "a4.layer.section", 2)).toContain(D1_BODY);
  });

  it("顺完就清 —— 写成了的那一节不把上一节的维度再传给下一节", async () => {
    let nth = 0;
    // 三节都要挂得上证据：`readOutline` 会把一条证据都没分到的那一节丢掉（`stages.ts`），
    // 丢掉的话这一条测的就成了「大纲折了几节」。
    const three = outlineJson([
      { id: "S1", ids: ["E1"] },
      { id: "S2", ids: ["E2"] },
      { id: "S3", ids: ["E2"] },
    ]);
    const { calls } = await run({
      outline: three,
      reply: (hint, fallback) => (hint === "a4.layer.section" && nth++ === 0 ? "" : fallback),
    });
    // S2 接下了 D1（上一条断言的事），S3 就不该再收到一遍 D1。
    expect(userText(calls, "a4.layer.section", 2)).not.toContain(D1_BODY);
  });

  it("最后一节也没写成时记一句 —— 没有「下一节」可顺，那几维这一遍真的没人写", async () => {
    const one = outlineJson([{ id: "S1", ids: ["E1", "E2"] }]);
    const { written } = await run({
      outline: one,
      reply: (hint, fallback) => (hint === "a4.layer.section" ? "" : fallback),
    });
    expect(written.notes.join("\n")).toContain("这几维这一遍没人接下");
  });
});

/* -------------------------------------------------------------------------- */
/* 暖缓存那一次                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 某一次调用的**缓存前缀**：system 段，加上打了断点的那一块。
 *
 * 缓存键是逐字节比的，所以暖缓存那一次和各节那几次的这两样必须一模一样。对不上的后果不是
 * 报错，是**缓存永远命不中** —— 屏幕上什么都看不出来，只有账单上那八万 token 一遍遍地重算。
 */
const cachePrefix = (calls: Recorded[], hint: string, nth = 0): { system: string; stable: string } => {
  const hit = calls.filter((c) => c.hint === hint)[nth];
  if (!hit) throw new Error(`没有第 ${nth + 1} 次 ${hint} 调用（实到：${calls.map((c) => c.hint).join("、")}）`);
  const system = hit.messages
    .filter((m) => m.role === "system")
    .map((m) => String(m.content))
    .join("\n");
  const parts = hit.messages.flatMap((m) =>
    Array.isArray(m.content) ? (m.content as { text: string; cache?: boolean }[]) : []
  );
  const marked = parts.filter((p) => p.cache);
  if (marked.length !== 1) throw new Error(`${hint} 这一次打了 ${marked.length} 个缓存断点，该是一个`);
  return { system, stable: marked[0].text };
};

describe("暖缓存那一次", () => {
  const outline = outlineJson([
    { id: "S1", ids: ["E1"] },
    { id: "S2", ids: ["E2"] },
  ]);

  it("发一次，排在所有分节之前", async () => {
    const { calls } = await run({ outline });
    const hints = calls.map((c) => c.hint);
    expect(hints.filter((x) => x === "a4.layer.warm")).toHaveLength(1);
    expect(hints.indexOf("a4.layer.warm")).toBeLessThan(hints.indexOf("a4.layer.section"));
  });

  it("发出去的前缀和各节那几次逐字节相同 —— 对不上就是白暖", async () => {
    const { calls } = await run({ outline });
    const warm = cachePrefix(calls, "a4.layer.warm");
    for (const nth of [0, 1]) {
      const section = cachePrefix(calls, "a4.layer.section", nth);
      expect(section.system).toBe(warm.system);
      expect(section.stable).toBe(warm.stable);
    }
  });

  it("断点后面那一段叫它别动笔 —— 一动笔就会被那点额度截断，而截断是抛异常", async () => {
    const { calls } = await run({ outline });
    const warmCall = calls.find((c) => c.hint === "a4.layer.warm");
    const parts = (warmCall?.messages.find((m) => Array.isArray(m.content))?.content ?? []) as {
      text: string;
      cache?: boolean;
    }[];
    expect(parts).toHaveLength(2);
    expect(parts[1].cache).toBeUndefined();
    expect(parts[1].text).toContain("不写任何报告内容");
  });

  it("暖不成不牵连这一轮：各节照写，只在缺口清单里留一句", async () => {
    const { calls, written } = await run({
      outline,
      reply: (hint, fallback) => {
        if (hint === "a4.layer.warm") throw new Error("那一次没连上");
        return fallback;
      },
    });
    // 两节照旧写完 —— 暖缓存是优化不是必需。
    expect(calls.filter((c) => c.hint === "a4.layer.section")).toHaveLength(2);
    expect(written.report.blocks.length).toBeGreaterThan(0);
    // 不留这一句的话，账单上多出来的那笔钱没有任何一处解释得了。
    expect(written.notes.join("\n")).toContain("暖提示缓存那一次没发成");
  });
});

/* -------------------------------------------------------------------------- */
/* 几节是并发写的                                                              */
/* -------------------------------------------------------------------------- */

/**
 * **这两条钉的是同一件事的两头：并发有没有真的发生，以及并发之后顺序有没有排回来。**
 *
 * 两头都属于「坏了不报错」那一类。退回串行是慢几节的时间 —— 实测一节 423 秒，而这一轮全部
 * 余量只有 2.7 分钟（`deadline.ts`），表现是「最近怎么老在收口那里被砍」；顺序没排回来的话，
 * 读者拿到的是一份按响应速度排序的报告，屏幕上看着完全正常。
 */
describe("几节一波并发写", () => {
  const four = outlineJson([
    { id: "S1", ids: ["E1"] },
    { id: "S2", ids: ["E2"] },
    { id: "S3", ids: ["E1"] },
    { id: "S4", ids: ["E2"] },
  ]);

  it("一波发完 —— 没有哪一节单独串行跑", async () => {
    /*
     * 判据：`fakeHarness` **先把这一次记进 `calls`、再去算回复**，所以算回复的那一刻
     * 「已经发出去几次」就是并发度的直接读数。
     *
     *   串行        →  1、2、3、4（每一次都要等上一次回来才发）
     *   第一节单独跑 →  1、4、4、4（上一版：那一节要把提示缓存写进去）
     *   一波发完     →  4、4、4、4（这一版：缓存改由 `a4.layer.warm` 那一次几秒钟写进去）
     */
    const seen: number[] = [];
    await run({
      outline: four,
      reply: (hint, fallback, calls) => {
        if (hint === "a4.layer.section") seen.push(calls.filter((c) => c.hint === hint).length);
        return fallback;
      },
    });
    expect(seen).toEqual([4, 4, 4, 4]);
  });

  it("六节也是一波 —— 并发上限就是大纲允许的节数上限", async () => {
    // 2026-09-04：节数封顶 5（证据 ≤2 条时 4），六节大纲会被并成五节 —— 这里给三条证据，
    // 看的是「封顶后的节数一波发完」，而不是 6。
    const six = outlineJson([1, 2, 3, 4, 5, 6].map((n) => ({ id: `S${n}`, ids: [["E1", "E2", "E3"][n % 3]] })));
    // 三条入账证据：封顶按「证据 ≤2 条时 4 节，否则 5 节」判，这里要走 5 那一档。
    const three = ledgerOf();
    if (!three.record(evidence({ propositionId: "D8-P1", claim: "据同一份公报", exactQuote: "据同一份公报" }))) {
      throw new Error(`第三条没入账：${three.rejections.at(-1)?.why}`);
    }
    const seen: number[] = [];
    await run({
      outline: six,
      ledger: three,
      reply: (hint, fallback, calls) => {
        if (hint === "a4.layer.section") seen.push(calls.filter((c) => c.hint === hint).length);
        return fallback;
      },
    });
    // 并发上限还是 4 的话这里是 4、4、4、4、6、6（两批）—— 而多出来的那一批就是多一节的
    // 墙上时间，实测 423 秒，比这一轮全部余量还长。
    expect(seen).toEqual([5, 5, 5, 5, 5]);
  });

  it("补写那一节写完得最晚，但排回它在大纲里的位置", async () => {
    // S1 砸一次 → 调用顺序是 S1、S2、S3、S4、S1补写，而报告里 S1 那一节要排在最前面。
    let nth = 0;
    const { written } = await run({
      outline: four,
      reply: (hint, fallback) => {
        if (hint !== "a4.layer.section") return fallback;
        const at = nth++;
        if (at === 0) return "";
        // 每一节写一个认得出来的小标题，用它读出最终顺序。
        const id = at === 4 ? "S1" : `S${at + 1}`;
        return fallback.replace("这一节说得出什么", `${id} 这一节`);
      },
    });
    const headings = written.report.blocks
      .filter((b) => b.type === "prose" && /^S\d 这一节$/.test(b.heading ?? ""))
      .map((b) => b.heading);
    expect(headings).toEqual(["S1 这一节", "S2 这一节", "S3 这一节", "S4 这一节"]);
  });
});

/* -------------------------------------------------------------------------- */
/* 指不到块的那几条 p0                                                          */
/* -------------------------------------------------------------------------- */

describe("一条模型都没送到的 p0 交回调用方", () => {
  const outline = outlineJson([{ id: "S1", ids: ["E1", "E2"] }]);

  it("没有可返修的对象时不发返修，但那几条 p0 从 unsentLint 出去", async () => {
    /*
     * 造的是「引了证据表里没有的编号」那条 p0（A4-B06）—— 它**指不到任何一个块**，因为
     * 「这份报告引了一枚点不开的编号」是报告级的事。两件事凑出这一份：
     *
     * - 分节那一次引 `E9`：台账里没有、`evidence_list` 里也没列，所以解析不开；
     * - 空台账：证据包为空，A4-B11（取回来没交代的那几条）于是不报 —— 那一条指得到
     *   `evidence_usage` 那个块，只要它在，这一支就走返修去了。
     *
     * 2026-09-05 起装配会剔掉 `evidenceRefs` 里不像编号的项（`stages.ts` 的 `normalizeLine`）；
     * `E9` 是编号形状，照留。正文里再引一次 `[E9]`，两处都要能被 B06 认出来。
     */
    const citesE9 = sectionJsonl(["这条产线的爬坡良率记录"])
      .replace('"E1"', '"E9"')
      .replace("机制本身不依赖这一轮的外部材料。", "机制本身不依赖这一轮的外部材料，爬坡良率见 [E9]。");
    const { written, calls } = await run({
      outline,
      ledger: new Ledger(),
      reply: (hint, fallback) => (hint === "a4.layer.section" ? citesE9 : fallback),
    });
    expect(calls.some((c) => c.hint === "a4.layer.repair")).toBe(false);
    expect(written.unsentLint.map((v) => v.rule)).toContain("A4-B06");
    expect(written.unsentLint.every((v) => v.severity === "p0")).toBe(true);
    expect(written.unsentLint.every((v) => v.block === undefined)).toBe(true);
    // 这一栏是 `lint` 的子集，不是它的替代 —— 出口对账那边照旧读整份 `lint`。
    for (const v of written.unsentLint) expect(written.lint).toContain(v);
    expect(written.notes.join("\n")).toContain("这几条进缺陷清单");
  });
});

/* -------------------------------------------------------------------------- */
/* 摘锚点排在冻文字之前                                                         */
/* -------------------------------------------------------------------------- */

describe("摘锚点排在冻文字之前", () => {
  const outline = outlineJson([{ id: "S1", ids: ["E1", "E2"] }]);
  /** 一条正常的锚点，一条带裸地址的 —— 后者摘不掉的话 `gateReport` 会判一条 A4-G01。 */
  const KEEP = "这条产线的爬坡良率记录";
  const DROP = "董办那份跟这次研究没交集的看板 https://intranet.example.com/board";

  const hooksOfReport = (report: ReportBlocks): string[] =>
    report.blocks.flatMap((b: Block) => (b.type === "judgment" ? b.internalValidationHooks : []));

  it("摘掉的那一条不在落库的块里、也不在转写出来的原文里", async () => {
    const { written } = await run({
      outline,
      hooks: [KEEP, DROP],
      stripAnchors: async (report) => {
        const stripped = stripHooks(report.blocks, [KEEP]);
        report.blocks = stripped.blocks;
        return { removed: stripped.removed };
      },
    });
    expect(hooksOfReport(written.report)).toEqual([KEEP]);
    expect(written.text).toContain(KEEP);
    expect(written.text).not.toContain(DROP);
  });

  it("gate 的账是摘之后那一份算的 —— 摘晚一步这里会多一条 A4-G01", async () => {
    const after = await run({
      outline,
      hooks: [KEEP, DROP],
      stripAnchors: async (report) => {
        const stripped = stripHooks(report.blocks, [KEEP]);
        report.blocks = stripped.blocks;
        return { removed: stripped.removed };
      },
    });
    expect(after.written.gate.violations.filter((x) => x.rule === "A4-G01")).toHaveLength(0);

    // 对照：压根不摘的那一遍，那条裸地址会被渲染进正文并判 p0。这一条同时证明上面那句
    // 「摘之后算的」不是因为这条规则本来就不触发。
    const none = await run({ outline, hooks: [KEEP, DROP] });
    expect(none.written.gate.violations.map((x) => x.rule)).toContain("A4-G01");
  });

  it("摘了几条记在 trace 上 —— 摘掉不留痕的话「没有内部裁决路径」和「有一条但被摘了」长得一样", async () => {
    const { notes } = await run({
      outline,
      hooks: [KEEP, DROP],
      stripAnchors: async (report) => {
        const stripped = stripHooks(report.blocks, [KEEP]);
        report.blocks = stripped.blocks;
        return { removed: stripped.removed };
      },
    });
    const note = notes.find((n) => n.label === "分层成稿");
    expect(JSON.stringify(note?.["摘掉的内部锚点"])).toContain(DROP);
  });
});

/* -------------------------------------------------------------------------- */
/* 决断包穿过重排那一步（ISS-238）                                              */
/* -------------------------------------------------------------------------- */

describe("决断包穿过分层重排", () => {
  const outline = outlineJson([{ id: "S1", ids: ["E1"] }]);
  const BRIEF_LINE = JSON.stringify({
    type: "command_brief",
    recommendation: {
      action: "本季只做中尺寸这一段的良率验证",
      intent: "季末拿到那条产线的爬坡良率区间",
      whyNow: "认证窗口在本季",
      confidence: "初步提示",
      evidenceEffect: "narrowed",
      evidenceEffectWhy: "E1 把需求侧那一段的量级收窄了",
    },
    proposedOrders: [{ role: "交付技术", outcome: "拿到那条产线的爬坡良率记录", dueOn: "2026-09-19", acceptance: ["按批次的良率表"] }],
    controls: { mustNot: [], changeTriggers: ["良率区间低于门槛"], abortConditions: ["产线投产推迟"] },
  });

  it("收口交的那一行走完重排还在，而且不占块的位置", async () => {
    /*
     * 重排那一步是拿 `parseBlocks` 的 `sources` 重拼整份 JSONL 的。决断包不是块、不在
     * `sources` 里 —— 不显式带过来的话它就在这一步没了，而 `assembleReport` 之后没有
     * 任何一处看得出少了它。
     */
    const before = (await run({ outline, playbook: [], reply: (hint, fallback) => fallback })).written;
    const { written } = await run({
      outline,
      playbook: [],
      reply: (hint, fallback) => (hint === "a4.layer.closing" ? `${fallback}\n${BRIEF_LINE}` : fallback),
    });
    expect(written.report.commandBrief?.recommendation.action).toContain("中尺寸");
    expect(written.report.commandBrief?.proposedOrders[0].role).toBe("交付技术");
    // 块的个数和没有决断包那一遍一模一样：它挂在报告之上，不占正文的位置。
    expect(written.report.blocks).toHaveLength(before.report.blocks.length);
    expect(written.report.appendixFrom).toBe(before.report.appendixFrom);
    // 纯文本面也不该多出一句 —— 那份是论证。
    expect(written.text).not.toContain("中尺寸这一段的良率验证");
  });

  it("行业题不交这一块时那一栏是空的，trace 上照实写", async () => {
    const { written, notes } = await run({ outline });
    expect(written.report.commandBrief).toBeUndefined();
    expect(notes.find((n) => n.label === "分层成稿")?.["决断包"]).toBe("行业题，不交");
  });
});
