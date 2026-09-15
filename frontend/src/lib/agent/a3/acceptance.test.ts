/*
 * 规格 §5 的七行验收表，逐行钉成断言。两个开关必须排在所有 import 之前。
 *
 * 这个文件一行生产代码都不改：它是来照的，不是来交活的。某一条红了，
 * 先分清红的是「实现走错了」还是「这条断言自己的前提不成立」——
 * 两档的处理完全不同，见 Task 17 Step 2。
 */
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "@/lib/research/search";
import type { A3Input } from "./prompt";
import type { runPreResearch as RunPreResearch } from "./run";
import type { BlindspotRuling, EvidenceLite, Provenance, TargetHit } from "./stages";
import type { AgentRunRecord } from "@/lib/data/types";

/*
 * 桩一：图谱。`runPreResearch` 无条件 `h.openContext(...)`，而 `Harness` 有意把那里的
 * 异常原样重抛（那段注释明写不许降级成空上下文），`vitest.config.ts` 也不读 env ——
 * 不打桩，离线跑到第一个 await 就死在图谱上，七个场景一条断言都轮不到。
 *
 * 姿态照 `run.v2.test.ts`，**不是** `harness.external.test.ts` 那一份：那一份用
 * 「`vi.importActual` 展开 + 覆盖 `openContext`」，成立的前提是消费方静态 import 在前。
 * 这里做不到 —— 消费方要等上面两个环境变量落定之后才许进来，只能动态 import，
 * 于是工厂里的 `vi.importActual` 会先把**真模块**塞进模块缓存，稍后动态进来的 harness
 * 拿到的就是真的那份，照样死在图谱上。`{ spy: true }` 不写工厂就没有这一下。
 *
 * 回的是「开过上下文但转纯外部」那一档。这**不是将就**：正式包的议题在图谱向量索引里
 * 检索不到，真模型整跑走的也正是这一支。
 */
vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

/*
 * 桩二：检索。场景 2 那条「一条外部证据都没入账时如实留痕」要的是**零入账**那一档，
 * 而**离线不打桩是有证据入账的**（mock 档 `providers()` 回 `[MockSearch]`，它取得到东西），
 * 那条断言不打桩必红。测试侧打桩，`src/lib/research/search.ts` 一字未动。
 *
 * 不能直接桩成 `NoSearch`：那个 class 在 `search.ts` 里**没有导出**，为了测试去导出它
 * 就是改那个文件（硬约束禁止）。所以自己拿一个同形状的源顶上：它在表里、不抛、
 * 一条都取不到 —— 这正是缺 key 那一档在生产上的行为。
 */
vi.mock("@/lib/research/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/research/search")>("@/lib/research/search");
  const none: SearchProvider = {
    name: "none",
    label: "未启用",
    windowed: false,
    reason: "测试桩：这一档表里有源，但一条都取不到",
    async search() {
      return [];
    },
  };
  return { ...actual, providers: () => ({ list: [none], skipped: [] }) };
});

const { openOntologyContext } = await import("@/lib/ontology/context");
type Opened = Awaited<ReturnType<typeof openOntologyContext>>;
const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "离线：这一池分不出高低",
  staticContext: "",
  snapshotId: null,
  trace: [{ at: "2026-08-27T00:00:00.000Z", label: "P3 候选池", kind: "graph", detail: {} }],
  warnings: [],
} as unknown as Opened;

/*
 * 这几个纯函数模块也一律 `beforeAll` 里动态进来。
 *
 * 静态 import 它们看着无害，但 `./verify` 顶上就挂着 `@/lib/research/search`：
 * 静态 import 会让上面那个工厂在环境变量落定之前先跑一遍。这一层不赌它没事，
 * 全部按「消费方先、被打桩的模块后」走。
 */
let runPreResearch: typeof RunPreResearch;
let delta: typeof import("@/lib/agent/a1a/delta");
let dispose: typeof import("./dispose");
let cardMod: typeof import("./card");
let verify: typeof import("./verify");
let trigger: typeof import("./trigger");
let provenance: typeof import("./provenance");
let blindspot: typeof import("./blindspot");

beforeAll(async () => {
  vi.mocked(openOntologyContext).mockResolvedValue(external);
  runPreResearch = (await import("./run")).runPreResearch;
  delta = await import("@/lib/agent/a1a/delta");
  dispose = await import("./dispose");
  cardMod = await import("./card");
  verify = await import("./verify");
  trigger = await import("./trigger");
  provenance = await import("./provenance");
  blindspot = await import("./blindspot");
});

/**
 * 把文件顶上那个检索桩撤掉一次，换回真模块，让罐头检索源真的取到东西 ——
 * 「有证据入账」那一档只能这么拿到。姿态照 `run.v2.test.ts` 末尾那一组：
 * 重来一遍模块图之后 `@/lib/ontology/context` 也是新的一份，那一桩要重配一次。
 *
 * **这一下不影响别的场景**：它们用的是 `beforeAll` 里那一份已经加载好的模块实例，
 * 那一份自己的 `search.ts` 仍然是桩（`resetModules` 清的是缓存，不是已经拿到手的实例）。
 */
async function withRealSearch(): Promise<typeof RunPreResearch> {
  vi.resetModules();
  vi.doMock("@/lib/research/search", async () => await vi.importActual("@/lib/research/search"));
  const ont = await import("@/lib/ontology/context");
  vi.mocked(ont.openOntologyContext).mockResolvedValue(external);
  return (await import("./run")).runPreResearch;
}

const modelLabels = (run: AgentRunRecord): string[] =>
  run.trace.filter((n) => n.kind === "model").map((n) => String(n.label));

const TARGETS = [{ kind: "judgment" as const, id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }];
const INPUT: A3Input = {
  issueId: "ISS-950",
  title: "要不要盯住这家新公司",
  scope: null,
  material: "某公司发布了 agent 编排产品，面向国内中大型客户。",
  judgments: [{ id: "J-2", statement: "今年不会有新玩家", standing: "在版" }],
  targets: TARGETS,
  watched: ["渠道代理商"],
};
const blind: BlindspotRuling = {
  isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: [],
};
function prov(): Provenance {
  return provenance.makeProvenance("ISS-950");
}
function ev(id: string, group: string): EvidenceLite {
  return {
    id, claim: "c", sourceRef: `https://a.com/${id}`, date: "2026-08-27T00:00:00.000Z",
    tier: "A", cosourceKey: group, provenance: prov(),
  };
}

describe("§5 场景 1 · 卡片疲劳", () => {
  it("同一事件连着五天来，纯转载零产出，只有真多出来的那句算增量", () => {
    const day1 = "某公司发布了 agent 编排产品，面向国内中大型客户。";
    const stream = [day1, day1, day1, `${day1}首批签了三家银行。`, day1];
    const deltas = stream.slice(1).map((s) => delta.declareDelta({ existing: day1, incoming: s }));
    expect(deltas.every((d) => d.verdict === "merged")).toBe(true);
    expect(deltas.filter((d) => d.delta.length > 0)).toHaveLength(1);
  });

  it("第二次预研出的是增量卡，不是第二张新卡", async () => {
    const first = await runPreResearch(INPUT);
    const second = await runPreResearch({ ...INPUT, prevStages: first.doc.stages });
    expect(second.doc.stages!.card.kind).toBe("increment");
  });
});

describe("§5 场景 2 · 盲区", () => {
  /*
   * **这一条本来是照计划原文写的**：只跑一遍 `runPreResearch(INPUT)`，断言 `critic` 在、
   * 且 `modelSlot` 是 `null` 或 `"alt"`。跑通了，但它**根本没走到「三判据都满足」那一档** ——
   * 文件顶上那个检索桩让这一轮零入账，可信度那一格是 `null`，`isBlindspot` 恒为 `false`。
   * 一条标题写着「三判据都满足」、实际跑的是三判据没满足的用例，就是一盏假绿灯。
   *
   * 所以三判据这一半改成直接喂 `ruleBlindspot`：**每一条判据都单独破一次**，
   * 破掉哪一条都要翻成不是盲区 —— 这才叫「三判据」。三条全满足时预算档才抬到 `BUDGET_HIT`
   * （规格说的「进那一道」在这一层能落到的就是这个）。
   *
   * 这不是把场景口径改了去迁就实现，是把口径真的钉上；批判那一半原样留在下面。
   */
  it("三判据都满足才算盲区 —— 近、可信、够大，破掉哪一条都翻", () => {
    const hit: TargetHit = { target: TARGETS[0], match: "challenges", why: "正是新玩家", hops: null };
    const all = { entities: [], hits: [hit], evidence: [ev("E1", "dom:a")], watched: [], magnitude: "material" as const };
    const yes = blindspot.ruleBlindspot(all);
    expect(yes.isBlindspot).toBe(true);
    // 近：一条靶点都没撞上就是「远」
    expect(blindspot.ruleBlindspot({ ...all, hits: [] }).isBlindspot).toBe(false);
    // 可信：台账最高只有 C 档，撑不起一句「他该看这个」
    expect(blindspot.ruleBlindspot({ ...all, evidence: [{ ...ev("E1", "dom:a"), tier: "C" }] }).isBlindspot).toBe(false);
    // 够大：量级判不出来就不算
    expect(blindspot.ruleBlindspot({ ...all, magnitude: "unknown" }).isBlindspot).toBe(false);
    /*
     * 三条都满足这一档才多查两轮。
     *
     * **但别把这一行读成「生产上盲区会抬预算」** —— `pickBudget` 里 `isBlindspot` 那个
     * 或分支今天在生产上到不了：`run.ts` 定预算时台账还是空的，可信度那一格是 `null`，
     * 盲区旗恒为假，抬预算的实际只有「撞上了靶点」那一半。这是末节欠账第 10 条说的事，
     * 只是那一条写着「为喂这个恒假旗子而编的入参已经拆掉」，而入参与这个或分支都还在。
     */
    expect(verify.pickBudget({ hits: [hit], blindspot: yes })).toBe(verify.BUDGET_HIT);
  });

  it("批判这一段一定跑过，而且机检定的事不许记成模型判的", async () => {
    const r = await runPreResearch(INPUT);
    // 要么机检定了（`modelSlot` 必须是 null），要么异系模型判了（必须是 alt，不是主链那格）
    expect(r.doc.stages!.critic).toBeDefined();
    expect(r.doc.stages!.critic.modelSlot === null || r.doc.stages!.critic.modelSlot === "alt").toBe(true);
  });

  it("判据不满足 → 走最省的核验档，而且这一轮的账全程留痕", () => {
    expect(verify.pickBudget({ hits: [], blindspot: { ...blind, isBlindspot: false } })).toBe(verify.BUDGET_MISS);
    expect(verify.pickBudget({ hits: [], blindspot: blind })).toBe(verify.BUDGET_HIT);
  });

  it("一条外部证据都没入账时如实留痕，不冒充核验过", async () => {
    const r = await runPreResearch(INPUT);
    /*
     * 这几条成立**全靠文件顶上那个 `search.ts` 的桩**：源表里有一个源，但它一条都取不到。
     * 桩去掉的话罐头检索源是取得到东西的，这几条就该红 —— 那时候红的是这里的前提，
     * 要补的是桩，**不是** `search.ts`，也不是往 `verify.ts` 里加一个只为让它变绿的开关。
     *
     * 另外：`searchless` 的口径是「这一轮一条外部证据都没入账」，**不是「一个检索源都没有」**——
     * `providers()` 三条路都返回非空表，「源表为空」这一档在生产上根本不存在。
     */
    expect(r.doc.stages!.evidence).toEqual([]);
    expect(r.doc.stages!.searchless).toBe(true);
    expect(r.doc.stages!.card.body).toContain("这一轮没有外部核验");
  });
});

describe("§5 场景 3 · 反确认", () => {
  const target = TARGETS[0];
  const contra: TargetHit = { target, match: "challenges", why: "正是新玩家", hops: 1 };
  const support: TargetHit = { target, match: "supports", why: "跟原判断一致", hops: 1 };

  it("同等强度下矛盾方向排在支持方向前面", () => {
    const evidence = [ev("E1", "dom:a"), ev("E2", "dom:b")];
    expect(dispose.cardPriority({ hits: [contra], blindspot: blind, evidence }))
      .toBeGreaterThan(dispose.cardPriority({ hits: [support], blindspot: blind, evidence }));
  });

  it("没有一条因为跟既有判断不符而被判成不看了", () => {
    const r = dispose.suggestDisposition({
      impact: { impactType: "outOfScope", proposalType: "noAction", targetRef: null, statement: "x", basis: ["E1"] },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: "2026-08-27T00:00:00.000Z", provenance: prov(), hits: [contra],
    });
    expect(r.action).not.toBe("dismiss");
  });
});

describe("§5 场景 4 · 触发器闭环", () => {
  it("深研沉淀的推翻条件进表时也只到 proposed —— 命中只提示重议，不自动重议", () => {
    const t = trigger.proposeTrigger({
      seq: 1,
      condition: "那家公司公布了国内客户名单",
      targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
      source: "overturnCondition",
      onFire: "proposeReopen",
      nowIso: "2026-08-27T00:00:00.000Z",
      provenance: prov(),
    });
    expect(t.status).toBe("proposed");
    expect(t.onFire).toBe("proposeReopen");
    // onFire 的三个值全是提案或通知 —— 没有一个会自己改状态
    expect(["proposeDiscuss", "proposeReopen", "notify"]).toContain(t.onFire);
  });
});

describe("§5 场景 5 · 升级连续性（2026-09-05 改：预研不取证）", () => {
  /*
   * v2 的设计是预研先核一遍、证据带进深研（`A4Input.preEvidence`）。那条线在生产上从没接上
   * （`store.ts` 构造深研入参时不传，`prompt.ts` 上写着「今天生产上恒为 undefined」），而它让
   * 预研多花 30–60 秒抓页、抽取。预研 v3 撤了外部核验：预研只回答值不值得，证据由深研自己取。
   * 所以这里守的是相反的不变量 —— 卡上不许出现指向台账的编号，因为根本没有台账。
   */
  it("预研不取证：证据表恒空、searchless 恒真、卡上依据只有先验标记", async () => {
    const run = await withRealSearch();
    const r = await run(INPUT);
    const s = r.doc.stages!;
    expect(s.searchless).toBe(true);
    expect(s.evidence).toEqual([]);
    for (const b of s.card.basis) expect(b.startsWith("[P]")).toBe(true);
    expect(modelLabels(r.run).some((l) => l.includes("a4.extract"))).toBe(false);
  });
});

describe("§5 场景 6 · 时效", () => {
  it("一轮的模型调用有硬上界：对靶点 + 写 + 批判 + 质量门返修 ≤ 2 + 批判修正 ≤ 1", async () => {
    const r = await runPreResearch(INPUT);
    const modelCalls = modelLabels(r.run).length;
    expect(modelCalls).toBeLessThanOrEqual(6);
    // 预研 v3 没有检索轮：这两个常量还在（深研的轮内取证复用它们的口径），但预研不再读。
    expect(verify.BUDGET_HIT.maxRounds).toBeLessThanOrEqual(2);
    expect(verify.BUDGET_MISS.maxRounds).toBe(1);
  });
});

describe("§5 场景 7 · 30 秒卡", () => {
  it("卡不超预算，而且「发生了什么 + 建议什么」两件事都在卡上", async () => {
    const r = await runPreResearch(INPUT);
    const card = r.doc.stages!.card;
    expect(card.chars).toBeLessThanOrEqual(cardMod.CARD_BUDGET);
    expect(cardMod.checkCard(card).filter((v) => v.severity === "p0")).toEqual([]);
    expect(/建议(议一议|先待定|不看了)/.test(card.body)).toBe(true);
  });
});
