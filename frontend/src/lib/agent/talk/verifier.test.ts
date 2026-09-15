import { beforeAll, describe, expect, it } from "vitest";

import { Harness } from "@/lib/agent/harness";
import type { DeliberationEntry, TalkPoint } from "./point";
import type { Evidence } from "@/lib/research/ledger";
import { findDesync, reviewCandidate, VERIFIER_PROMPT, checkVerdict } from "./verifier";

const e = (
  turn: number, trigger: string, before: string, after: string, kind: DeliberationEntry["kind"] = "concede",
): DeliberationEntry => ({ turn, trigger, before, after, kind, rationale: "r" });

/** 一串接得上的日志：第 k 条的 after 就是第 k+1 条的 before。 */
const chain: DeliberationEntry[] = [
  e(1, "他给了 E7 的口径差异", "更支持 A", "两说"),
  e(2, "他连着压了三轮", "两说", "两说", "hold"),
];

/** 台账里真在的那条。`ev` 只填断言用得到的几栏。 */
const ev = (id: string): Evidence =>
  ({ id, claim: "口径差异", exactQuote: "原文", sourceDomain: "stats.gov.cn", sourceTier: "A",
     independenceGroup: `src:${id}`, propositionId: "P1", url: "https://x" } as unknown as Evidence);

const point = (statement: string): TalkPoint => ({
  issueId: "ISS-1", thesis: "口径不一致", statements: ["按同口径算是两说"], openQuestions: [],
  candidate: { statement, basis: "E7 与 E8 两条独立源", reopenIf: "统计局改了口径的定义" },
});

let h: Harness;
beforeAll(() => {
  process.env.TKOS_MODEL_MOCK = "1";
  h = new Harness({ agent: "A5", slot: "pro" });
});

describe("判断动了但账对不上的轮次", () => {
  it("改判引的 E 编号台账里没有 → 点出来（编号是编的）", () => {
    const d = findDesync([e(3, "按 [E9] 我改了", "两说", "更支持 B")], {
      evidenceIds: ["E7"], nowTurn: 3, nowJudgement: "更支持 B",
    });
    expect(d).toHaveLength(1);
    expect(d[0].turn).toBe(3);
    expect(d[0].why).toContain("E9");
  });

  /*
   * 报告正文里的引用是 `[E9, E10]` 这种形状（`a4/blocks/registry.ts:196` 那句注释是出处），
   * 而报告正文原样进对谈前缀 —— 模型照着上下文里的样子写多编号，是它最自然的行为。
   * 这一档从前静默放行：抠编号的正则只认单编号，`match` 直接回 null，判据 1 一声不吭。
   * 把 `cite.ts` 的正则改回只认 `\[E\d+\]`，下面两条都会红。
   */
  it("一次引两个编号、两个都是编的 → 两条都点出来（`[E9, E10]` 这种写法）", () => {
    const d = findDesync([e(3, "按 [E9, E10] 我改了", "两说", "更支持 B")], {
      evidenceIds: ["E7"], nowTurn: 3, nowJudgement: "更支持 B",
    });
    expect(d).toHaveLength(2);
    expect(d.map((x) => x.why).join("｜")).toContain("E9");
    expect(d.map((x) => x.why).join("｜")).toContain("E10");
  });

  it("一次引两个编号、只有一个是编的 → 只点那一个（`[E7][E9]` 这种写法）", () => {
    const d = findDesync([e(3, "按 [E7][E9] 我改了", "两说", "更支持 B")], {
      evidenceIds: ["E7"], nowTurn: 3, nowJudgement: "更支持 B",
    });
    expect(d).toHaveLength(1);
    expect(d[0].why).toContain("E9");
    expect(d[0].why).not.toContain("E7");
  });

  it("改判引的 E 编号台账里真在 → 不点", () => {
    expect(findDesync([e(3, "按 [E7] 我改了", "两说", "更支持 B")], {
      evidenceIds: ["E7"], nowTurn: 3, nowJudgement: "更支持 B",
    })).toHaveLength(0);
  });

  it("前一条的 after 与后一条的 before 不接 → 点出后一条（中间少记了一次改判）", () => {
    const d = findDesync(
      [e(1, "他给了 E7 的口径差异", "更支持 A", "两说"), e(2, "他又提了一条", "更支持 B", "更支持 C")],
      { evidenceIds: ["E7"], nowTurn: 2, nowJudgement: "更支持 C" },
    );
    expect(d).toHaveLength(1);
    expect(d[0].turn).toBe(2);
    expect(d[0].before).toBe("更支持 B");
    expect(d[0].why).toContain("接不上");
  });

  it("判断变了却一条日志都没记 → 点出这一轮（日志整条缺席）", () => {
    const d = findDesync(chain, { evidenceIds: ["E7"], nowTurn: 3, nowJudgement: "更支持 B" });
    expect(d).toHaveLength(1);
    expect(d[0].turn).toBe(3);
    expect(d[0].before).toBe("两说");        // 最后一条日志的 after
    expect(d[0].after).toBe("更支持 B");     // 判断现在的样子
  });

  it("一串接得上、判断也对得上 → 一条都不点", () => {
    expect(findDesync(chain, { evidenceIds: ["E7"], nowTurn: 2, nowJudgement: "两说" })).toEqual([]);
  });

  it("空日志 + 判断没动 → 一条都不点（第一轮还没表态的常态）", () => {
    expect(findDesync([], { evidenceIds: [], nowTurn: 1, nowJudgement: "" })).toEqual([]);
  });
});

describe("候选判断的独立复核", () => {
  it("台账支持、日志接得上 → 通过，且不带 rollbackTo", async () => {
    const r = await reviewCandidate(h, {
      point: point("按同口径算，两说"), ledger: [ev("E7"), ev("E8")], log: chain, desync: [],
    });
    expect(r.pass).toBe(true);
    expect(r.rollbackTo).toBeUndefined();
  });

  it("有对不上的轮次 → 打回，退回那一次的 before，且这一下不叫模型", async () => {
    const r = await reviewCandidate(h, {
      point: point("更支持 B"), ledger: [ev("E7"), ev("E8")], log: chain,
      desync: [{ turn: 3, before: "两说", after: "更支持 B", why: "日志里没有这一次改判" }],
    });
    expect(r.pass).toBe(false);
    expect(r.rollbackTo).toBe("两说");
    expect(r.why.length).toBeGreaterThan(0);
    expect(r.modelSlot).toBeNull();   // 机检就能定的事不花一次模型调用
  });

  it("独立源不足两组 → 打回，也不叫模型", async () => {
    const r = await reviewCandidate(h, {
      point: point("按同口径算，两说"), ledger: [ev("E7")], log: chain, desync: [],
    });
    expect(r.pass).toBe(false);
    /*
     * 整句对，不是 `toContain("独立")`：这句话上屏，而它说的必须就是它检的那件事 ——
     * 检的是整份台账有几组，不是「支撑这条候选的证据有几组」。上一版那句「候选判断需要
     * 至少两组独立源，当前台账只有 N 组」把两件事说成一件，而 `toContain("独立")` 对
     * 两种措辞都绿。
     */
    expect(r.why[0]).toBe("这份台账只有 1 组独立源，撑不起一条强判断");
    expect(r.modelSlot).toBeNull();
  });

  it("异系复核：叫模型那一次用的槽位与主对谈那个不同", async () => {
    const r = await reviewCandidate(h, {
      point: point("按同口径算，两说"), ledger: [ev("E7"), ev("E8")], log: chain, desync: [],
    });
    expect(r.modelSlot).not.toBeNull();
    expect(r.modelSlot).not.toBe(h.slot);
  });

  it("通过也不许落确认 —— 确认只能由人按下", async () => {
    const r = await reviewCandidate(h, {
      point: point("按同口径算，两说"), ledger: [ev("E7"), ev("E8")], log: chain, desync: [],
    });
    expect(Object.keys(r)).not.toContain("confirmed");
    expect(JSON.stringify(r)).not.toContain("confirmed");
  });

  /**
   * 复核器返回什么就交回什么的那一句话由这一条钉住。
   *
   * `checkVerdict` 自己的三种非法形状在下面那个 describe 里有单测，但**调用点**没有 ——
   * 而删掉 `reviewCandidate` 里那句 `checkVerdict` 的正是调用点。这一条走完整条
   * `reviewCandidate`：机检两道都过、真走到那一次模型调用，只是模型交回来的 `pass`
   * 不是布尔。
   *
   * 让模型交回非法形状用的是一个假 Harness（只实现这条路用到的 `slot`/`note`/`callMessages`，
   * 姿态照 `a4/stage-write.test.ts` 里那个）。**没有为此在 `mock.ts` 里加变体键**：那需要让
   * 假模型按提示词内容分叉，等于为一条测试在生产文件里开一道暗门。
   */
  it("复核模型交回来的 pass 不是布尔 → 打回，不许原样信了它", async () => {
    const fake = {
      slot: "pro",
      note: () => {},
      callMessages: async () => ({ text: `{"pass":"看起来可以","why":"一句话"}` }),
    } as unknown as Harness;

    const r = await reviewCandidate(fake, {
      point: point("按同口径算，两说"), ledger: [ev("E7"), ev("E8")], log: chain, desync: [],
    });
    expect(r.pass).toBe(false);
    expect(r.why.join("")).toContain("pass");
    // 这一下是真叫了模型的（机检两道都过），所以 modelSlot 不是 null
    expect(r.modelSlot).toBe("alt");
  });
});

describe("复核模型返回的形状校验", () => {
  it("pass 缺失 → 打回且 why 非空", () => {
    const r = checkVerdict({ why: ["理由"] }, "alt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.review.pass).toBe(false);
      expect(r.review.why.length).toBeGreaterThan(0);
      expect(r.review.why.join("")).toContain("pass");
    }
  });

  it("pass 是字符串而不是布尔 → 打回且 why 非空", () => {
    const r = checkVerdict({ pass: "true", why: ["理由"] }, "alt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.review.pass).toBe(false);
      expect(r.review.why.length).toBeGreaterThan(0);
      expect(r.review.why.join("")).toContain("pass");
    }
  });

  it("why 是字符串而不是数组 → 打回且 why 非空", () => {
    const r = checkVerdict({ pass: true, why: "理由字符串" }, "alt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.review.pass).toBe(false);
      expect(r.review.why.length).toBeGreaterThan(0);
      expect(r.review.why.join("")).toContain("why");
    }
  });

  /*
   * M13：`undefined` 进来时不许自己抛。
   *
   * `JSON.stringify(undefined)` 返回的是 `undefined` 这个值本身（不是字符串），
   * 上一版直接 `.slice(0, 80)` 会当场抛 `TypeError` —— 而这个函数存在的全部理由就是
   * 「不许抛异常把整个结算带崩」。今天 `parseJson` 造不出 `undefined`，所以这是一条防御；
   * 把 `peek` 里的 `?? x` 摘掉（退回 `JSON.stringify(x).slice(...)`）→ 这一条红。
   */
  it("返回的是 undefined → 照旧打回，不自己抛把整轮结算带崩", () => {
    const r = checkVerdict(undefined, "alt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.review.pass).toBe(false);
      expect(r.review.why.join("")).toContain("undefined");
      expect(r.review.modelSlot).toBe("alt");
    }
  });

  it("合法形状 → ok: true", () => {
    const r = checkVerdict({ pass: true, why: ["理由1", "理由2"] }, "alt");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.pass).toBe(true);
      expect(r.value.why).toEqual(["理由1", "理由2"]);
    }
  });
});

describe("复核提示词", () => {
  it("三件事都在，而且三处改写都到位了", () => {
    for (const must of [
      "你没有参与之前的对话",
      "强判断 ≥2 独立源",
      "判断方向变了、但证据集与论证集没有对应",
      "退回该判断的",
      "判断状态",     // 规格里写的是 Point
      "让步日志",     // 规格里写的是 deliberation_log
    ]) expect(VERIFIER_PROMPT).toContain(must);
  });

  it("内部字段名与自造词一个都不许进提示词", () => {
    for (const banned of ["deliberation_log", "轨迹同步性", "TalkPoint", "candidate", "reopenIf"])
      expect(VERIFIER_PROMPT).not.toContain(banned);
  });

  it("真正的标识符要原样留着", () => {
    expect(VERIFIER_PROMPT).toContain("E{n}");
  });

  it("输出格式一节在提示词里", () => {
    expect(VERIFIER_PROMPT).toContain("输出格式");
    expect(VERIFIER_PROMPT).toContain("pass");
    expect(VERIFIER_PROMPT).toContain("why");
  });
});
