// src/lib/agent/talk/turn.test.ts
import { beforeAll, describe, expect, it } from "vitest";

import { checkProposal, type PointProposal } from "@/lib/agent/talk/point";
import { lookupEvidence } from "./lookup";
import type { Evidence } from "@/lib/research/ledger";
import { runTalkTurn, type TurnDeps, type TurnMsg, type TurnRound } from "./turn";

beforeAll(() => {
  process.env.TKOS_MODEL_MOCK = "1";
});

/**
 * 按脚本走的上游。每一项是「这一轮上游回什么」。
 *
 * 这里不用 src/lib/models/mock.ts 的罐头：那张表返回的是字符串，出不了 `tool_calls`
 * （见 turn.ts 里 `TurnRound` 的注释）。脚本注入还有一个好处 —— 「连要四次工具」
 * 和「要三次就收口」是两个脚本，不是同一个罐头键的两种读法。
 */
const script = (rounds: { text: string; calls: { name: string; args: string }[] }[]): TurnRound => {
  let i = 0;
  return async () => {
    const r = rounds[Math.min(i, rounds.length - 1)];
    i += 1;
    return { text: r.text, calls: r.calls.map((c, n) => ({ id: `c${i}-${n}`, ...c })) };
  };
};

/*
 * 参数一律照 schema 发 `{ query }` —— `tools.ts` 上这个工具只有这一栏而且必填，真模型
 * 只会发这个形状。发 `{ id }` 的那一版走的是兜底分支，生产上走不到。
 */
const wantThree = [
  { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E1" }) }] },
  { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E2" }) }] },
  { text: "", calls: [{ name: "micro_research", args: JSON.stringify({ question: "2025Q2 同口径份额" }) }] },
  { text: "按 E1 我不改这一句：口径对不上。", calls: [] },
];
const wantFour = [
  ...wantThree.slice(0, 3),
  { text: "", calls: [{ name: "micro_research", args: JSON.stringify({ question: "再查一条" }) }] },
  { text: "先说结论，缺的那条我另外查。", calls: [] },
];

const baseDeps = (round: TurnRound): TurnDeps => ({
  round,
  lookup: (q) => [{ id: q.id ?? "E1", claim: "出货 1200 万片", site: "国家统计局", tier: "A", quote: "出货 1200 万片（原文）" }],
  micro: async () => ({ kind: "found", entries: [], independentGroups: 2 }),
  ontology: async () => ({ kind: "not_found", note: "桩：图里没有" }),
  calculate: () => ({ ok: false, why: "桩：这份报告里没有可复算的算式。" }),
  propose: () => {},
  escalate: () => {},
});

const o = {
  system: "S",
  prefix: "P",
  history: "H",
  ask: "这一句我不同意",
  issueId: "ISS-1",
  // 生产那一路只在已有报告的议题上进来（route.ts 那道闸），所以默认这一档。
  hasReport: true,
  nowMs: () => 1_000,
};

/** 一次一个值往下走的注入时钟。走到尽头就停在最后一个值上。 */
const stepClock = (values: number[]) => { let i = 0; return () => values[Math.min(i++, values.length - 1)]; };

/**
 * 把每一轮真发出去的那组消息记下来。断言要落在**喂回模型的那段内容**上 ——
 * 落在脚本自己写的正文上证明不了工具的产出真的进了模型。
 */
const watch = (inner: TurnRound): { round: TurnRound; seen: TurnMsg[][] } => {
  const seen: TurnMsg[][] = [];
  return {
    seen,
    round: async (messages, tools) => {
      seen.push(messages.map((m) => ({ ...m })));
      return inner(messages, tools);
    },
  };
};

/** 最后一轮里喂回模型的那几条工具返回值。 */
const fedBack = (seen: TurnMsg[][]): string =>
  (seen[seen.length - 1] ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => m.content ?? "")
    .join("\n");

describe("挑战轮的轮内工具链", () => {
  it("单轮内完成 两次 evidence_lookup + 一次 micro_research，取回来的证据真进了模型", async () => {
    const w = watch(script(wantThree));
    const r = await runTalkTurn(baseDeps(w.round), o);
    expect(r.trace.toolCalls.map((c) => c.name)).toEqual(["evidence_lookup", "evidence_lookup", "micro_research"]);
    // 断言落在喂回模型的那段工具返回值上：编号与那句 claim 都得在，他下一轮才引得出。
    const firstFed = w.seen[1].filter((m) => m.role === "tool").map((m) => m.content ?? "").join("\n");
    expect(firstFed).toContain("E1");
    expect(firstFed).toContain("出货 1200 万片");
    expect(r.trace.escalated).toEqual([]);   // 没触及预算就不该有升级
  });

  it("回应就是模型那一轮的正文本身 —— 没有升级也没有查不到时，一个字不多", async () => {
    const r = await runTalkTurn(baseDeps(script(wantThree)), o);
    expect(r.reply).toBe("按 E1 我不改这一句：口径对不上。");
  });

  it("report_calculate：数字段由代码算、原样拼进回应；工具返回里带纪律（2026-09-05）", async () => {
    const rounds = [
      { text: "", calls: [{ name: "report_calculate", args: JSON.stringify({ mode: "compute", overrides: { events: 20 }, override_source: "他说一个月二十件" }) }] },
      { text: "这套算式最敏感的是事件数。", calls: [] },
    ];
    const w = watch(script(rounds));
    const deps = baseDeps(w.round);
    const asked: unknown[] = [];
    const r = await runTalkTurn(
      {
        ...deps,
        calculate: (ask) => {
          asked.push(ask);
          return {
            ok: true,
            model: { ref: "v#1", index: 1, heading: "算式甲", layer: "", params: [], outputs: [], disclaimer: "" },
            params: [{ id: "events", label: "每月事件数", unit: "件", value: 20, origin: "override", range: "1–60" }],
            outputs: [{ label: "每月可回收", expr: "x", value: 1.75, unit: "个单日固定支出" }],
            overrideSource: "他说一个月二十件",
          };
        },
      },
      o
    );
    expect(asked).toEqual([{ ref: undefined, overrides: { events: 20 }, overrideSource: "他说一个月二十件" }]);
    // 屏幕上：模型正文在前，程序算的那一段在后，数字来自代码。
    expect(r.reply).toContain("这套算式最敏感的是事件数。");
    expect(r.reply).toContain("每月可回收 ＝ 1.75 个单日固定支出");
    expect(r.reply).toContain("20件（您改的）");
    // 喂回模型的工具结果里带纪律：不许重新誊写数字。
    const fed = w.seen[1].filter((m) => m.role === "tool").map((m) => m.content ?? "").join("\n");
    expect(fed).toContain("不要在正文里重新写一遍数字");
    // 它不占检索预算。
    expect(r.trace.escalated).toEqual([]);
  });

  it("report_calculate 的 explain 档忽略模型塞进来的覆盖值 —— 解释含义只按报告默认", async () => {
    const rounds = [
      { text: "", calls: [{ name: "report_calculate", args: JSON.stringify({ mode: "explain", overrides: { events: 20 } }) }] },
      { text: "按报告默认算是这样。", calls: [] },
    ];
    const asked: unknown[] = [];
    const deps = baseDeps(script(rounds));
    await runTalkTurn({ ...deps, calculate: (ask) => { asked.push(ask); return deps.calculate(ask); } }, o);
    expect(asked).toEqual([{ ref: undefined, overrides: undefined, overrideSource: undefined }]);
  });

  it("report_calculate 算不了：照实回给模型，不往屏幕上拼数字", async () => {
    const rounds = [
      { text: "", calls: [{ name: "report_calculate", args: JSON.stringify({ mode: "explain", ref: "旧版#0" }) }] },
      { text: "这份报告里的算式已经换版了，我算不了。", calls: [] },
    ];
    const r = await runTalkTurn(baseDeps(script(rounds)), o);
    expect(r.reply).toBe("这份报告里的算式已经换版了，我算不了。");
  });

  it("按号查与语义查分流 —— 断言落在取证据那一头收到的查询上", async () => {
    const got: { id?: string; text?: string }[] = [];
    const rounds = [
      { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E1" }) }] },
      { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "份额" }) }] },
      { text: "两条都看过了。", calls: [] },
    ];
    const deps = baseDeps(script(rounds));
    await runTalkTurn({ ...deps, lookup: (q) => { got.push(q); return deps.lookup(q); } }, o);
    expect(got).toEqual([{ id: "E1" }, { text: "份额" }]);
  });

  it("micro_research 查不到：这一轮照样给出回应，并明说是先验", async () => {
    const deps = { ...baseDeps(script(wantThree)), micro: async () => ({ kind: "not_found" as const, tried: ["q"], why: "无源" }) };
    const r = await runTalkTurn(deps, o);
    // 「先验」这句话由 turn.ts 在把 not_found 喂回模型之前就写进工具返回值里，
    // 并原样进这一轮回应 —— 所以它不是脚本里的字符串，是被测代码产出的。
    expect(r.reply).toContain("我的先验，未验证");
    // 查不到还要挂一条异步补证（Task 8 交给这一层的那件事，规格 HP-5）——
    // 光说「稍后补上」而不挂，下一轮他还是问不到。
    expect(r.trace.escalated.some((e) => e.type === "async_research" && e.payload.question === "2025Q2 同口径份额")).toBe(true);
  });

  it("超时的 micro_research：转异步 + 回应里带那句告知", async () => {
    // 第一次读表 0（起点），之后读到 40 秒 —— 超过 BUDGET.syncTimeoutMs
    const r = await runTalkTurn(baseDeps(script(wantThree)), { ...o, nowMs: stepClock([0, 40_000]) });
    expect(r.trace.escalated.length).toBeGreaterThan(0);
    expect(r.trace.escalated[0].type).toBe("async_research");
    expect(r.trace.escalated[0].payload.issueId).toBe("ISS-1");
    expect(r.reply).toContain("查证结果稍后补上");
  });

  it("预算用尽不静默：第四次工具调用被拦下之后仍然出一段回应，且缺口转了异步", async () => {
    const r = await runTalkTurn(baseDeps(script(wantFour)), o);
    expect(r.trace.toolCalls).toHaveLength(3);
    expect(r.trace.escalated.some((e) => e.type === "async_research")).toBe(true);
    // 第四轮被拦，第五轮说话 —— 而告知那一句拼在正文后面，所以是 toContain 不是 toBe。
    expect(r.reply).toContain("先说结论，缺的那条我另外查。");
    // 这条用例的正题就是「不静默」：转了异步一定当面说。
    expect(r.reply).toContain("查证结果稍后补上");
  });

  it("两个时长都记下来了，且整轮不短于轮首", async () => {
    /*
     * 这一条不用 `stepClock`：那个助手读完最后一格就停在那一格上，而这一轮读表的次数比它
     * 给的格数多，于是轮首与整轮读到的是同一个数 ——「整轮在轮首之后」那一半就断不出来了。
     * 换成每读一次走 7 毫秒、读多少次都用不完的时钟（同 `fixtures/pressure.ts` 的做法）。
     */
    let tick = 0;
    const r = await runTalkTurn(baseDeps(script(wantThree)), { ...o, nowMs: () => tick++ * 7 });
    /*
     * 断的是**两个数真被填过**。原先这里写的是 `typeof … === "number"`，而两栏在 `TurnTrace`
     * 上都是必填 `number`、进 `runTalkTurn` 时又被初始化成 0 —— 那条断言 TypeScript 已经替它
     * 保证了，删掉 `turn.ts` 里那两行赋值它照旧全绿，这个埋点等于没人盯。
     *
     * 注入的时钟第一格 0 被 `startedAt` 吃掉，之后每读一次表往前走，所以两个数都必然 >0，
     * 且整轮那一次读表在轮首之后。**具体是几毫秒不断言** —— 那取决于这一轮往返了几次，
     * 是编排的实现细节，不是这条测试要守的东西。
     */
    expect(r.trace.timing.firstTokenMs).toBeGreaterThan(0);
    expect(r.trace.timing.totalMs).toBeGreaterThan(r.trace.timing.firstTokenMs);
  });

  it("提议往下递之前拆掉路由参数 —— 带着它下去会被整份拒", async () => {
    const got: PointProposal[] = [];
    // 这份 args 就是模型照 schema 会发的形状：point_id 必填，四栏可选。
    const args = JSON.stringify({ point_id: "TP-1", thesis: "决策权已经移到业务线", statements: ["评分不再是唯一门槛"] });
    const rounds = [
      { text: "", calls: [{ name: "propose_point_update", args }] },
      { text: "这一条我改了，因为你刚才提到的口径。", calls: [] },
    ];
    await runTalkTurn({ ...baseDeps(script(rounds)), propose: (p) => got.push(p) }, o);
    expect(got).toHaveLength(1);
    expect("point_id" in got[0]).toBe(false);
    expect(got[0].thesis).toBe("决策权已经移到业务线");
    // 递下去那份必须真能过校验器 —— 两头是一根线（tools.ts 的 schema ↔ point.ts 的白名单）
    expect(checkProposal(got[0]).ok).toBe(true);
  });
});

describe("模型主动发起的转手：平参数重整成嵌套形状", () => {
  const spoke = (text: string, args: string) =>
    script([
      { text: "", calls: [{ name: "escalate", args }] },
      { text, calls: [] },
    ]);

  it("重整之后带上 issueId 才过得了校验，登记一条并当面告知", async () => {
    const args = JSON.stringify({ type: "async_research", question: "2025Q3 同口径份额" });
    const r = await runTalkTurn(baseDeps(spoke("这一条我先给先验。", args)), o);
    expect(r.trace.escalated).toHaveLength(1);
    expect(r.trace.escalated[0].type).toBe("async_research");
    expect(r.trace.escalated[0].payload.issueId).toBe("ISS-1");
    expect(r.reply).toContain("查证结果稍后补上");
  });

  it("多带了一个这一种不认的键：不登记、不告知，拒绝理由喂回去让它改口", async () => {
    // why 是转深研那一种要的 —— 出现在转检索上说明它把两种出口搞混了。
    const args = JSON.stringify({ type: "async_research", question: "2025Q3 同口径份额", why: "这题该回深研" });
    const seen: TurnMsg[][] = [];
    const inner = spoke("那我换个说法：这一条按先验说。", args);
    const round: TurnRound = async (messages, tools) => {
      seen.push([...messages]);   // 这一轮真发出去的那一组，不是我传进去的那个串
      return inner(messages, tools);
    };
    const r = await runTalkTurn(baseDeps(round), o);

    expect(r.trace.escalated).toEqual([]);
    expect(r.reply).not.toContain("查证结果稍后补上");

    const fed = seen[seen.length - 1]
      .filter((m) => m.role === "tool")
      .map((m) => m.content ?? "")
      .join("\n");
    expect(fed).toContain("不认字段");
    expect(fed).toContain("why");
  });
});

describe("按号查被拦下时不许把编号当成问句", () => {
  it("预算用尽之后再按号查：不登记升级，喂回去的就是拒绝理由", async () => {
    const rounds = [
      { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E1" }) }] },
      { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E2" }) }] },
      { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E3" }) }] },
      // 第四次：预算已经用尽，而这一次是按号查 —— 编号不是他的问题，转不出去。
      { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E4" }) }] },
      { text: "台账上这几条我看过了。", calls: [] },
    ];
    const w = watch(script(rounds));
    const r = await runTalkTurn(baseDeps(w.round), o);

    expect(r.trace.toolCalls).toHaveLength(3);
    expect(r.trace.escalated).toEqual([]);          // 一条内部编号不是一个说得清的缺口
    expect(r.reply).not.toContain("查证结果稍后补上");
    expect(r.reply).not.toContain("E4");             // 屏幕上不许出现「关于「E4」我需要查证」
    expect(fedBack(w.seen)).toContain("没有明确的缺口可转异步");
  });
});

describe("一轮之内不吃预算的那两个工具也有上限", () => {
  it("一轮里发三份迁移提议：只收下第一份", async () => {
    const got: PointProposal[] = [];
    const one = (thesis: string) => ({
      name: "propose_point_update",
      args: JSON.stringify({ point_id: "TP-1", thesis }),
    });
    const rounds = [
      { text: "", calls: [one("第一份"), one("第二份"), one("第三份")] },
      { text: "改完了。", calls: [] },
    ];
    const w = watch(script(rounds));
    await runTalkTurn({ ...baseDeps(w.round), propose: (p) => got.push(p) }, o);
    expect(got).toHaveLength(1);
    expect(got[0].thesis).toBe("第一份");
    // 后来那两份要如实回它，不能假装收下了
    expect(fedBack(w.seen)).toContain("下一轮");
  });

  it("一轮里转五个不同的缺口：最多登记三条", async () => {
    const one = (question: string) => ({
      name: "escalate",
      args: JSON.stringify({ type: "async_research", question }),
    });
    const rounds = [
      { text: "", calls: [one("缺口一"), one("缺口二"), one("缺口三"), one("缺口四"), one("缺口五")] },
      { text: "剩下的下一轮再说。", calls: [] },
    ];
    const landed: string[] = [];
    const w = watch(script(rounds));
    const r = await runTalkTurn(
      { ...baseDeps(w.round), escalate: (e) => landed.push(e.type) },
      o,
    );
    expect(r.trace.escalated).toHaveLength(3);
    expect(landed).toHaveLength(3);
    expect(r.reply).not.toContain("缺口四");
    expect(r.reply).not.toContain("缺口五");
  });

  /*
   * 上限判在 `land()` 这个出口上，所以循环自己造的那几条也受同一个限 —— 光在模型转手那条路上
   * 设限等于没设：一轮里查不到、被预算挡掉都会自己造一条转手，那两条不进上限的话，一轮照样能
   * 攒出四五句「稍后补上」的当面告知，而后台真起了四五个任务。
   */
  it("循环自己造的那几条转手也占上限：两条模型转手 + 一条查不到 + 一条被预算挡掉 = 只登记三条", async () => {
    const gap = (question: string) => ({
      name: "escalate",
      args: JSON.stringify({ type: "async_research", question }),
    });
    const rounds = [
      {
        text: "",
        calls: [
          gap("缺口一"),
          gap("缺口二"),
          // 第三条是循环自己造的：这一次取证没查到 → not-found 那条分支里 land()
          { name: "micro_research", args: JSON.stringify({ question: "缺口三" }) },
          // 第四条也是循环自己造的：第二次取证被 admit 挡掉（micro 只给一次）→ land(verdict.escalate)
          { name: "micro_research", args: JSON.stringify({ question: "缺口四" }) },
        ],
      },
      { text: "剩下的下一轮再说。", calls: [] },
    ];
    const landed: string[] = [];
    const w = watch(script(rounds));
    const r = await runTalkTurn(
      {
        ...baseDeps(w.round),
        micro: async () => ({ kind: "not_found", tried: ["查过两家"], why: "没有可引的材料" }),
        escalate: (e) => {
          if (e.type === "async_research") landed.push(e.payload.question);
        },
      },
      o,
    );
    // 三条：模型那两条 + 查不到那一条。被预算挡掉那一条撞上上限，落不进去。
    expect(r.trace.escalated).toHaveLength(3);
    expect(landed).toEqual(["缺口一", "缺口二", "缺口三"]);
    expect(r.reply).not.toContain("缺口四");
    // 超额那一条要如实回它，不能假装转出去了
    expect(fedBack(w.seen)).toContain("收满");
  });

  it("同一个缺口转两次算一条 —— 第二次既不登记也不重复告知", async () => {
    const one = () => ({
      name: "escalate",
      args: JSON.stringify({ type: "async_research", question: "同一个缺口" }),
    });
    const rounds = [
      { text: "", calls: [one(), one()] },
      { text: "说完了。", calls: [] },
    ];
    const landed: string[] = [];
    const r = await runTalkTurn(
      { ...baseDeps(script(rounds)), escalate: (e) => landed.push(e.type) },
      o,
    );
    expect(r.trace.escalated).toHaveLength(1);
    expect(landed).toHaveLength(1);
    // 同一句告知只说一遍
    expect(r.reply.split("同一个缺口")).toHaveLength(2);
  });
});

describe("交接深研的告知按「这条议题有没有报告」改口", () => {
  // 每次现造一个 —— `script` 自己记着走到第几轮了，两条用例共用一个会从尽头接着走。
  const handoff = () =>
    script([
      { text: "", calls: [{ name: "escalate", args: JSON.stringify({ type: "deep_research_handoff", why: "缺口扩到整个议题" }) }] },
      { text: "这一条我先不改。", calls: [] },
    ]);

  it("已有报告：如实说它不替他作废现有报告，不说「我需要回到深研重新梳理」", async () => {
    const r = await runTalkTurn(baseDeps(handoff()), { ...o, hasReport: true });
    expect(r.trace.escalated).toHaveLength(1);
    // 字面照 tools.ts 里 tellHim 现有实现。原来这里钉的是「打回重研」——
    // 一颗屏幕上不存在的键，模型照着说等于让他去找一个按不到的出口。
    expect(r.reply).toContain("不会替你把现有报告作废");
    expect(r.reply).not.toContain("打回重研");
    expect(r.reply).not.toContain("我需要回到深研重新梳理");
  });

  it("还没有报告：照旧那句「我需要回到深研重新梳理」", async () => {
    const r = await runTalkTurn(baseDeps(handoff()), { ...o, hasReport: false });
    expect(r.reply).toContain("我需要回到深研重新梳理");
    expect(r.reply).not.toContain("打回重研");
  });
});

describe("两条取证路喂回模型的形状是同一份", () => {
  /**
   * 一条**带口径**的证据。口径四件套挂在 `Evidence` 上，`describe` 靠它印出「口径：」那一行 ——
   * 而上一版轮内取证那一支自己内联拼字符串，整条口径行是缺的。这条用例就是为那一行来的。
   */
  const withMeasure = {
    id: "E8",
    claim: "2025Q2 同口径份额 48%",
    exactQuote: "……同口径口径下前三家合计 48%……",
    siteName: "国家统计局",
    sourceDomain: "stats.gov.cn",
    sourceTier: "A",
    value: 48,
    unit: "%",
    period: "2025Q2",
    independenceGroup: "G1",
    url: "https://example.invalid/x",
    retrievedAt: "2026-08-27",
  } as unknown as Evidence;

  it("同一条证据：轮内现取回来的那一段，除了抬头逐字等于按编号查回来的那一段", async () => {
    const rounds = [
      { text: "", calls: [{ name: "evidence_lookup", args: JSON.stringify({ query: "E8" }) }] },
      { text: "", calls: [{ name: "micro_research", args: JSON.stringify({ question: "2025Q2 同口径份额" }) }] },
      { text: "两条我都看过了。", calls: [] },
    ];
    const w = watch(script(rounds));
    await runTalkTurn(
      {
        ...baseDeps(w.round),
        // 按编号查那一路走真的 `lookupEvidence`（映射与格式化都是被测的那一份）
        lookup: (q) => lookupEvidence([withMeasure], q),
        micro: async () => ({ kind: "found", entries: [withMeasure], independentGroups: 2 }),
      },
      o,
    );

    const toolsOf = (i: number) =>
      w.seen[i].filter((m) => m.role === "tool").map((m) => m.content ?? "");
    const byId = toolsOf(1)[0];        // 第 2 轮发出去时带着第 1 次工具的返回值
    const fresh = toolsOf(2)[1];       // 第 3 轮发出去时带着第 2 次工具的返回值

    // 两边都得有口径那一行 —— 缺了这一行，他这一轮问口径模型只能瞎猜
    expect(byId).toContain("口径：48%，2025Q2");
    expect(fresh).toContain("口径：48%，2025Q2");

    /*
     * 逐字相等（抬头那句「取到了，独立来源 N 组」是轮内取证这一路特有的，只多这一句）。
     * 断成整段而不是逐行 toContain：来源与原文两行顺序颠倒过一次，逐行断法抓不到。
     */
    expect(fresh).toBe(`取到了，独立来源 2 组：\n\n${byId}`);
  });

  it("缺原文引句时两边说的是同一句话，都不拿 claim 冒充引句", async () => {
    const noQuote = { ...(withMeasure as unknown as Record<string, unknown>) };
    delete noQuote.exactQuote;
    const one = noQuote as unknown as Evidence;
    const rounds = [
      { text: "", calls: [{ name: "micro_research", args: JSON.stringify({ question: "同口径份额" }) }] },
      { text: "看过了。", calls: [] },
    ];
    const w = watch(script(rounds));
    await runTalkTurn(
      {
        ...baseDeps(w.round),
        lookup: (q) => lookupEvidence([one], q),
        micro: async () => ({ kind: "found", entries: [one], independentGroups: 2 }),
      },
      o,
    );
    const fed = fedBack(w.seen);
    expect(fed).toContain("这一条没有原文引句，别当引句用");
    expect(fed).not.toContain("原文：2025Q2 同口径份额 48%");
  });
});

describe("ontology_lookup 喂回模型的那段", () => {
  const askOntology = (query: string) => [
    { text: "", calls: [{ name: "ontology_lookup", args: JSON.stringify({ query }) }] },
    { text: "说完了。", calls: [] },
  ];

  /** 取工具返回值：它是以 tool 角色喂回去的那一条。 */
  const toolReply = (seen: TurnMsg[][]): string => {
    const last = seen[seen.length - 1];
    const tool = [...last].reverse().find((m) => m.role === "tool");
    return tool?.content ?? "";
  };

  it("图服务取不到时，明写「不许说成公司没有这条」", async () => {
    // 这一条是整个分支存在的理由：一次真故障被读成「公司没记过」，
    // 那句话会被他当成结论，而屏幕上看不出任何异常。
    const w = watch(script(askOntology("01-J2")));
    await runTalkTurn(
      {
        ...baseDeps(w.round),
        ontology: async () => ({ kind: "unavailable", note: "图服务不可达（12ms）：ECONNREFUSED" }),
      },
      o,
    );
    const reply = toolReply(w.seen);
    expect(reply).toContain("不许说成公司没有这条");
    expect(reply).toContain("ECONNREFUSED");
  });

  it("图里确实没有时，说清这是正常结果不是故障", async () => {
    const w = watch(script(askOntology("从没记过的东西")));
    await runTalkTurn(
      { ...baseDeps(w.round), ontology: async () => ({ kind: "not_found", note: "按语义取「x」，图里没有对应条目" }) },
      o,
    );
    expect(toolReply(w.seen)).toContain("不是故障");
  });

  it("状态空着要明写「图未给」，不许省成一条没有状态的判断", async () => {
    // 省掉那一栏，模型读到的是一条没标状态的判断 —— 而这一层到处在教它
    // 「已确认的是公司口径」，于是它会被顺理成章地当成确认过的。
    const w = watch(script(askOntology("01-J2")));
    await runTalkTurn(
      {
        ...baseDeps(w.round),
        ontology: async () => ({
          kind: "found",
          mode: "code",
          items: [{ code: "01-J2", label: "架构能力即壁垒", text: "正文", status: "" }],
          recall: "",
          note: "按编号取「01-J2」，回 1 条",
        }),
      },
      o,
    );
    const reply = toolReply(w.seen);
    expect(reply).toContain("图未给");
    expect(reply).toContain("不等于已确认");
  });

  it("语义那一路要说清只回编号、不回正文", async () => {
    const w = watch(script(askOntology("毛利率为什么下滑")));
    await runTalkTurn(
      {
        ...baseDeps(w.round),
        ontology: async () => ({
          kind: "found",
          mode: "semantic",
          items: [{ code: "01-J2", label: "", text: "", status: "", type: "judgement", score: 0.82 }],
          recall: "召回的一段",
          note: "按语义取「毛利率为什么下滑」，回 1 条",
        }),
      },
      o,
    );
    const reply = toolReply(w.seen);
    expect(reply).toContain("只回编号");
    expect(reply).toContain("01-J2");
    expect(reply).toContain("0.820");
  });

  it("空 query 不打图服务", async () => {
    let called = 0;
    const w = watch(script(askOntology("   ")));
    await runTalkTurn(
      {
        ...baseDeps(w.round),
        ontology: async () => {
          called += 1;
          return { kind: "not_found", note: "" };
        },
      },
      o,
    );
    expect(called).toBe(0);
  });
});
