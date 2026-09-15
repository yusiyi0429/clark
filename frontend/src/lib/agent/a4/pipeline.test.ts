/**
 * 打桩注意（同 `harness.external.test.ts`）：先静态 import 被测的消费方，再动态 import
 * 被 mock 的模块 —— 顺序反了，`vi.importActual` 会把真模块塞进模块缓存。
 *
 * **为什么非打不可**：`openContext` 那一句在图服务连不上时抛 `AgentRunFailed` 就地失败，
 * 而这是故意的（`harness.ts` 里那段「不要在这里加 return」）。这台跑测试的机器没有图服务，
 * 所以这一句必须打桩，不然测的就只是「抛得对不对」。打的是**转纯外部**那一档：一号位真机
 * 上两次整跑走的都是这一档（正式包的议题在图谱向量索引里检索不到）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backfillMerged, mergedFromDraft, runDeepResearchV2, v2On } from "./pipeline";
import type { Draft } from "./draft";
import type { Merged } from "./reconcile";
import type { A4Input } from "./prompt";
import type { Evidence } from "@/lib/research/ledger";

vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

const { openOntologyContext } = await import("@/lib/ontology/context");
type Opened = Awaited<ReturnType<typeof openOntologyContext>>;
const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "这一池分不出高低（前 4 名分数拉不开）",
  staticContext: "",
  snapshotId: null,
  trace: [],
  warnings: [],
} as unknown as Opened;

describe("开关", () => {
  afterEach(() => {
    delete process.env.TKOS_DR_V2;
  });

  it("默认开 —— 这一版是默认那一支了", () => {
    expect(v2On()).toBe(true);
  });

  it("只有显式写 0 才回四链路那一支 —— 别的值一律当开", () => {
    process.env.TKOS_DR_V2 = "0";
    expect(v2On()).toBe(false);
    process.env.TKOS_DR_V2 = "1";
    expect(v2On()).toBe(true);
    // 空串是「.env 里留了这一行但没填值」，那不是「要走旧路」的意思。
    process.env.TKOS_DR_V2 = "";
    expect(v2On()).toBe(true);
  });
});

/** `A4Input`（`prompt.ts:43`）的真实形状：七栏都要给，`scope`/`preTake` 是可空不是可选。 */
const input = (title = "维信诺所处的行业"): A4Input => ({
  issueId: "ISS-TEST",
  title,
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  judgments: [],
});

/* -------------------------------------------------------------------------- */
/* N4 交回来读不出时，草稿不许蒸发                                              */
/* -------------------------------------------------------------------------- */

/**
 * 这几条测的是这条链上最贵的那次调用（N4，16k）**半途而废**时的处置。
 *
 * 为什么单测而不是整轮跑：整轮跑里 N4 的罐头是好的，而把罐头改坏就等于测罐头。这一段
 * 真正要按住的事实是 `parseMerged` 从不抛 —— 所以「对账白跑了」的常态是一份空的（或者
 * 缺几维的）合并稿，不是一个异常。
 */
const assertion = (text: string, loadBearing: boolean) => ({
  text,
  tag: "P" as const,
  confidence: "高" as const,
  timeSensitive: false,
  loadBearing,
  // 2026-09-07（ISS-240）加的一栏，跟这一段要测的东西无关，填兜底值即可（`draft.ts` 的 `ANSWER_SOURCES`）。
  answerIn: "公开可查" as const,
});

const draft: Draft = {
  thesis: "草稿那一版的总判断",
  sections: [
    {
      dim: "D1",
      thesis: "需求这一维的论点",
      body: "需求侧的机制原文",
      assertions: [assertion("需求侧本季度回落约两成", true), assertion("换机周期在拉长", false)],
    },
    {
      dim: "D8",
      thesis: "落回主体这一维的论点",
      body: "落回主体的机制原文",
      assertions: [assertion("那条产线的爬坡良率决定接不接得到单", true)],
    },
  ],
  unknowns: [],  playbook: [],
};

/** 只有 D1 读出来了的那一份 —— 「读出一部分」在真机上比「一维都读不出」常见。 */
const halfRead: Merged = {
  thesis: "对完账那一版的总判断",
  sections: [{ dim: "D1", thesis: "对完账的 D1 论点", body: "对完账的 D1 机制", tags: ["E*"] }],
  changes: [
    { assertion: "需求侧本季度回落约两成", from: "P", to: "E*", state: "证实", evidenceIds: ["E1"] },
  ],
  bad: [{ line: 4, why: "读不出来" }],
};

const empty: Merged = { thesis: "", sections: [], changes: [], bad: [{ line: 1, why: "不是一个对象" }] };

describe("backfillMerged —— 合并稿缺的那几维从草稿补回来", () => {
  it("一维都读不出时补成整份 —— 空的合并稿等于 N1 那一整份先验在这一轮里消失", () => {
    const out = backfillMerged(empty, draft);
    expect(out.filled).toEqual(["D1", "D8"]);
    expect(out.merged.sections.map((s) => s.dim)).toEqual(["D1", "D8"]);
    expect(out.merged.sections[0].body).toBe("需求侧的机制原文");
    // 总判断空着才退回草稿的。
    expect(out.merged.thesis).toBe("草稿那一版的总判断");
  });

  it("补进来的标签一律按未验证给：承重降 P!，非承重留 P", () => {
    const out = backfillMerged(empty, draft);
    expect(out.merged.sections[0].tags).toEqual(["P!", "P"]);
    expect(out.merged.changes.map((c) => c.state)).toEqual(["未验证", "未验证", "未验证"]);
    // 没有对过账就没有「已证实」这一档。
    expect(out.merged.changes.some((c) => c.to === "E*")).toBe(false);
  });

  it("只读出一部分时只补缺的那几维，读出来的原样留着", () => {
    const out = backfillMerged(halfRead, draft);
    expect(out.filled).toEqual(["D8"]);
    expect(out.merged.sections.map((s) => s.dim)).toEqual(["D1", "D8"]);
    // D1 是真的对过账的，不许被草稿那一版盖掉。
    expect(out.merged.sections[0].body).toBe("对完账的 D1 机制");
    expect(out.merged.sections[0].tags).toEqual(["E*"]);
    // D8 按未验证补。
    expect(out.merged.sections[1].tags).toEqual(["P!"]);
    // 总判断以读出来的那一版为准，坏行照旧留着（缺口清单要报它）。
    expect(out.merged.thesis).toBe("对完账那一版的总判断");
    expect(out.merged.bad).toHaveLength(1);
  });

  it("已经判过态的断言不许被补进来的「未验证」盖掉", () => {
    const out = backfillMerged(halfRead, draft);
    const hit = out.merged.changes.filter((c) => c.assertion === "需求侧本季度回落约两成");
    expect(hit).toHaveLength(1);
    expect(hit[0].state).toBe("证实");
  });

  it("八维都读出来了就一个字不动 —— 补齐只在缺的时候发生", () => {
    const full = mergedFromDraft(draft);
    const out = backfillMerged(full, draft);
    expect(out.filled).toEqual([]);
    expect(out.merged).toBe(full);
  });

  it("模型多交了一维（草稿里没有的）时不丢它", () => {
    const extra: Merged = {
      ...halfRead,
      sections: [...halfRead.sections, { dim: "D3", thesis: "多出来的一维", body: "多出来的机制", tags: ["P"] }],
    };
    const out = backfillMerged(extra, draft);
    expect(out.merged.sections.map((s) => s.dim)).toEqual(["D1", "D8", "D3"]);
  });
});

/**
 * 这两个离线 describe 都要在 `afterEach` 里把 `TKOS_DR_V2` 删掉。删的不是「开」——`v2On()`
 * 现在默认就是开的，`runDeepResearch` 也默认转发过来 —— 删的是**这个文件对它的显式设值**：
 * 留着的话，某一条用例把它设成 `0` 之后（比如为了看四链路那一支）就会漏给同一次 vitest 里
 * 后面的用例，而那时它们走的是另一条链路，没有一条是为它写的。`TKOS_MODEL_MOCK` 同理：
 * 假模型那一档是 `complete.ts` 最前面那个 if，漏出去会让后面的用例静静地不出网。
 */
const clearEnv = (): void => {
  delete process.env.TKOS_DR_V2;
  delete process.env.TKOS_MODEL_MOCK;
};

describe("离线跑一整条", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
    vi.mocked(openOntologyContext).mockReset();
    vi.mocked(openOntologyContext).mockResolvedValue(external);
  });
  afterEach(clearEnv);

  it("七个节点都跑到，产出的 A4Result 形状和上一版一致", async () => {
    const r = await runDeepResearchV2(input());
    expect((r.doc.sourceText ?? "").length).toBeGreaterThan(0);
    expect(r.evidencing.rounds.length).toBeGreaterThanOrEqual(1);
    expect(r.run.status).toBe("ok");
  });

  it("覆盖表进了 trace，八维一条不少", async () => {
    const r = await runDeepResearchV2(input("x"));
    const note = r.run.trace.find((n) => n.label === "覆盖表");
    expect(note).toBeDefined();
    expect(JSON.stringify(note?.detail)).toContain("D8");
  });

  it("完整台账跟着报告落库 —— 引句只在这一栏里", async () => {
    const r = await runDeepResearchV2(input("台账"));
    // 空数组也是 Array，所以先要有条目，再要有引句 ——
    // 「跟着落库」这件事只有这两条同时成立才叫做到了。
    expect(r.doc.ledger?.length).toBeGreaterThan(0);
    expect(r.doc.ledger![0].exactQuote.length).toBeGreaterThan(0);
    // 速查那一份没有引句，所以议事那一层非要这一栏不可。
    // 先钉 blocks 在，否则 `blocks?.evidence` 为 undefined 时下一行的意思会变。
    expect(r.doc.blocks).toBeDefined();
    expect(r.doc.blocks!.evidence.length).toBeGreaterThan(0);
    expect(r.doc.blocks!.evidence.every((e) => !("exactQuote" in e))).toBe(true);
  });
});

/**
 * 上面两条跑的是罐头齐全的那一路。这一条把罐头**换成读不出的东西**，测的是
 * 「这条链跑得通」不等于「罐头写得好」：每个节点交回来读不出时都折成一条缺口往下走
 * （HP-5：查不到是合法结果），这一轮照旧上屏，而不是抛。
 *
 * 打的是 `models/mock.ts` 而不是 `models/complete.ts`：假模型那一档在 `complete` 里是
 * 最前面那个 if，把 `mockText` 换掉就等于把每个节点的模型输出一次全换成垃圾，而请求
 * 组装、`jsonlContinue` 续写、`json` 参数那几条路径仍然走真的。
 *
 * 用 `doMock` + `resetModules` 而不是文件顶上的 `vi.mock`：后者会被提到文件最前面，
 * 上面那两条「罐头齐全」的用例就一起被换掉了 —— 同一个文件里要两套模型输出，只能按用例
 * 现打。重来一遍模块图之后 `@/lib/ontology/context` 也是新的一份，所以那一桩要重配一次。
 */
describe("罐头全读不出也要出得来", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
  });
  afterEach(() => {
    vi.doUnmock("@/lib/models/mock");
    vi.resetModules();
    clearEnv();
  });

  it("每个节点都交回读不出的东西，这一轮仍然 ok，缺口记在案", async () => {
    vi.doMock("@/lib/models/mock", () => ({
      modelMockOn: () => true,
      mockText: () => "这不是 JSON，也不是 JSONL，就是一段话。",
    }));
    vi.resetModules();
    const ont = await import("@/lib/ontology/context");
    vi.mocked(ont.openOntologyContext).mockResolvedValue(external);
    const { runDeepResearchV2: runGarbage } = await import("./pipeline");

    const r = await runGarbage(input("读不出的一轮"));
    expect(r.run.status).toBe("ok");

    // 缺口清单写在 `doc.sourceText` 文首（§N6）—— 正文可能是空的，这一段不能是。
    expect(r.doc.sourceText ?? "").toContain("【本轮机检未过的部分】");

    // N0/N1 各自的「读不出」都要落到缺陷清单上；草稿空了 N2 不排（2026-09-06，ISS-234：空草稿抽出的是编的题），
    // 这一条也要明写。
    const head = r.doc.sourceText ?? "";
    expect(head).toContain("N0 主体卡");
    expect(head).toContain("N1 草稿");
    expect(head).toContain("N1 草稿是空的，检索计划与取证不跑");

    /*
     * 没有命题就没有检索。**A4-N02 报一条 p1，不是逐维八条 p0**（2026-08-31 改）：
     * 整段没跑的那一轮，覆盖表上那八条说的是同一件事、指向同一个原因，而且没有一条是
     * 重写报告能改动的。逐维报 p0 的代价在 `RUN-A4-mth5jkf0-6` 上是实打实的 —— 它们把
     * N6 那一轮重写的预算占满，而真该重跑的收口没排上。
     */
    expect(r.evidencing.propositions).toBe(0);
    expect(r.evidencing.rounds).toHaveLength(0);
    const n02 = r.violations.filter((v) => v.rule === "A4-N02");
    expect(n02).toHaveLength(1);
    expect(n02[0].severity).toBe("p1");
    expect(r.degraded).toBe(true);

    /*
     * 于是这一轮压根不进重写循环（p1 不打回），报告一次成稿。**「取证整段没跑」这件事
     * 仍然要在缺口清单上看得见** —— 不重写和「这件事没发生过」是两回事。
     */
    expect(r.attempts).toBe(1);
    expect(head).toContain("N3 取证整段没跑");
  });
});

/* -------------------------------------------------------------------------- */
/* 预研那一轮的证据要能垫进这一轮的台账                                          */
/* -------------------------------------------------------------------------- */

/**
 * 一条「上一轮预研已经核过」的证据。字段照 `Ledger.record` 出来的样子填满 —— 它进来时
 * 不再过一遍入账三道门（引句早就定位过了），所以这里必须是完整体，不是 draft。
 */
const priorEvidence = (over: Partial<Evidence> = {}): Evidence => ({
  id: "E9",
  propositionId: "PRE-1",
  claim: "预研那一轮查到的说法",
  exactQuote: "预研那一轮查到的说法",
  url: "https://pre.example.gov.cn/a",
  supportRelation: "supports",
  evidenceType: "statistic",
  authorityClass: "official_statistics",
  usedAs: "current_state",
  sourceDomain: "pre.example.gov.cn",
  contentHash: "pre-hash-1",
  retrievedAt: "2026-08-20T00:00:00.000Z",
  sourceTier: "A",
  span: [0, 10],
  excerpt: "预研那一轮查到的说法",
  verificationStatus: "span_matched",
  independenceGroup: "",
  ...over,
});

describe("预研证据垫底", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
    vi.mocked(openOntologyContext).mockReset();
    vi.mocked(openOntologyContext).mockResolvedValue(external);
  });
  afterEach(clearEnv);

  it("不给这一栏时，行为和以前一模一样", async () => {
    const r = await runDeepResearchV2(input("没有预研证据"));
    expect(r.run.status).toBe("ok");
    expect(r.doc.ledger?.some((e) => e.propositionId === "PRE-1")).toBeFalsy();
  });

  it("垫进来的证据进了落库台账，而且重新编了号", async () => {
    /*
     * 编号必须重编：预研那一轮的 id 也是从 E1 起自增的，原样带过来会和本轮取的撞。
     * 这里故意给一个 `E9` —— 本轮台账里不该再有 E9 这个号指着它。
     */
    const r = await runDeepResearchV2({ ...input("有预研证据"), preEvidence: [priorEvidence()] });
    const mine = (r.doc.ledger ?? []).filter((e) => e.propositionId === "PRE-1");
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe("E1");
    // 编号之外一个字都没动。
    expect(mine[0].excerpt).toBe("预研那一轮查到的说法");
    expect(mine[0].sourceTier).toBe("A");
  });

  it("本轮和预研的编号不撞", async () => {
    const r = await runDeepResearchV2({
      ...input("编号不撞"),
      preEvidence: [priorEvidence(), priorEvidence({ url: "https://pre.example.gov.cn/b", contentHash: "pre-hash-2" })],
    });
    const ids = (r.doc.ledger ?? []).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* -------------------------------------------------------------------------- */
/* 措辞那一组规则要在默认这条链上真的跑                                          */
/* -------------------------------------------------------------------------- */

/**
 * 这一组规则（回避式措辞、空词、`member:` 死链、感叹号、无依据的绝对化）住在 `validate.ts`，
 * 而那个文件整份只在 `TKOS_DR_V2=0` 那条对照链上跑 —— 默认这条七步链的三层门
 * （`blocks/lint.ts` / `gate.ts` / `audit.ts`）一条都不看词面。所以这里钉的不是「规则算得对」
 * （那是下面 `wordingViolations` 自己的事），是**这条链有没有把它接上**：删掉 `pipeline.ts`
 * 收口那一句，这一条就必须红。
 *
 * 罐头本身是干净的（一条措辞违规都不带），所以要往里塞一段脏的 —— 只塞不加数字的纯文字，
 * 免得连带触发 A4-B02「带数字没绑证据」，那样红起来的原因就不是这一条了。
 */
describe("措辞那一组在默认这条链上", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
  });
  afterEach(() => {
    vi.doUnmock("@/lib/models/mock");
    vi.resetModules();
    clearEnv();
  });

  it("报告正文里的回避式措辞、空词、感叹号都记进这一轮的违规", async () => {
    vi.doMock("@/lib/models/mock", async () => {
      const actual = await vi.importActual<typeof import("@/lib/models/mock")>("@/lib/models/mock");
      const dirty = JSON.stringify({
        type: "prose",
        heading: "这一段是用例塞进来的脏话",
        md: "机会与挑战并存，我们要靠这一套打法赋能一线！",
      });
      return {
        ...actual,
        mockText: (hint?: string, messages: Parameters<typeof actual.mockText>[1] = []) => {
          const out = actual.mockText(hint, messages);
          return hint === "a4.layer.closing" ? `${out}\n${dirty}` : out;
        },
      };
    });
    vi.resetModules();
    const ont = await import("@/lib/ontology/context");
    vi.mocked(ont.openOntologyContext).mockResolvedValue(external);
    const { runDeepResearchV2: runDirty } = await import("./pipeline");

    const r = await runDirty(input("措辞"));

    // 先确认那一段真的进了报告原文 —— 没进的话下面三条不成立的原因是罐头，不是这条链。
    expect(r.doc.sourceText ?? "").toContain("机会与挑战并存");

    const rules = r.violations.map((v) => v.rule);
    expect(rules).toContain("G-08"); // 回避式措辞
    expect(rules).toContain("G-09"); // 空词（打法、赋能）
    expect(rules).toContain("G-10"); // 感叹号

    // **一律 p1**：这一组是记账不是闸。判成 p0 会让每一份措辞不干净的报告直接 degraded，
    // 而措辞改不动一次按块的返修。
    const wording = r.violations.filter((v) => ["G-08", "G-09", "G-10"].includes(v.rule));
    expect(wording.every((v) => v.severity === "p1")).toBe(true);
  });
});
