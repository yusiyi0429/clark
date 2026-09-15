/*
 * 这一段跑真的 `runPreResearch`，所以要罐头模型。`TKOS_PERSIST=0` 是防御性的：
 * 这个文件不碰 store，但 harness 的依赖链上任何一处将来碰了，快照都不该被测试写脏。
 * 两个赋值必须排在所有 import 之前，模块在 beforeAll 里 await import。
 *
 * **两处桩少一个这个文件就跑不起来**，下面各写清为什么。
 */
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "@/lib/research/search";
import type { A3Input } from "./prompt";
import type { runPreResearch as RunPreResearch } from "./run";

/*
 * 桩一：图谱。`runPreResearch` 无条件 `h.openContext(...)`，而 `Harness` 有意把那里的异常
 * 原样重抛（那段注释明写不许降级成空上下文）；`vitest.config.ts` 不读 env，
 * 所以离线跑到第一个 await 就会死在图谱上，一条断言都轮不到。
 *
 * `harness.external.test.ts` 那一份用的是「`vi.importActual` 展开 + 覆盖 `openContext`」，
 * 它成立的前提是**消费方（harness）静态 import 在前** —— 那个文件顶上就写着这句话。
 * 这里做不到：`runPreResearch` 要等上面两个环境变量落定之后才许 import，
 * 而 ESM 的静态 import 一律先于文件体执行。消费方只能动态进来，
 * 于是那个姿态在这里会反过来踩坑：文件顶上先 `await import` 图谱，
 * 工厂里的 `vi.importActual` 把**真模块**塞进模块缓存，
 * 稍后动态进来的 harness 拿到的就是真的那份，跑到第一个 await 就死在图谱上。
 *
 * 所以这一处换成 `{ spy: true }`：不写工厂就没有 `vi.importActual`，
 * 缓存不会被污染，其余导出照旧透传，只把 `openContext` 这一格改掉。
 * （下面 `search.ts` 那一桩仍然是工厂 —— 它在文件顶上没有被 import 过，
 * 工厂第一次跑就发生在 `verify.ts` 要它的那一刻，轮不到污染。）
 *
 * 回的是「开过上下文但转纯外部」那一档（`mode: "external_only"`、`bundle: null`、
 * `anchor: null`）。这**不是将就**：正式包的议题在图谱向量索引里检索不到，
 * 两次真模型整跑走的也正是这一支。
 */
vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

/*
 * 三个 v2 段的 spy 桩：默认全透传，只在那两条降级用例里各让一处抛一次。
 * 用 `{ spy: true }` 而不是工厂 —— 工厂里的 `vi.importActual` 会把真模块塞进模块缓存，
 * 而这个文件的消费方（`run.ts`）是动态进来的，缓存被污染之后桩就不生效了（同上一段）。
 */
vi.mock("./targets", { spy: true });
vi.mock("./critic", { spy: true });

/*
 * 桩二：检索。**离线不打桩的话是有证据入账的**（`providers()` 在 mock 档回 `[MockSearch]`，
 * 它取得到东西），于是下面「这一轮没有外部核验」那两条断言会红。
 * 要那一档就得让源表里那个源一条都取不到 —— 这是测试侧打桩，
 * `src/lib/research/search.ts` 一字未动。
 *
 * 不能直接桩成 `NoSearch`：那个 class 在 `search.ts` 里**没有导出**，
 * 而为了测试去导出它就是改那个文件（硬约束禁止）。所以这里自己拿一个同形状的源顶上，
 * 它在表里、也不抛，就是一条都取不到 —— 这正是缺 key 那一档在生产上的行为。
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
const mocked = vi.mocked(openOntologyContext);

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

let runPreResearch: typeof RunPreResearch;

beforeAll(async () => {
  mocked.mockResolvedValue(external);
  runPreResearch = (await import("./run")).runPreResearch;
});

const V1: A3Input = {
  issueId: "ISS-901",
  title: "要不要盯住这家新公司",
  scope: null,
  material: "某公司发布了 agent 编排产品，面向国内中大型客户。",
  judgments: [{ id: "J-2", statement: "今年不会有新玩家", standing: "在版" }],
};

describe("A3 v2", () => {
  it("不给靶点库就还是 v1：模型调用不超过三次（写 + 批判 + 至多一次修正）、没有 stages", async () => {
    const r = await runPreResearch(V1);
    expect(r.doc.stages).toBeUndefined();
    // `AgentRunRecord` 上**没有** `steps` 这一格 —— 原来那句 `r.run.steps?.length ?? 0`
    // 恒为 0，它对着任何实现都绿。模型调用次数只能从 trace 数：`harness.ts` 里
    // 每次 `callMessages` 都往 trace 里 push 一条 `kind: "model"`。
    // 数出来的是**发起过几次调用**（超时那一支什么都没发出去，也算一次），
    // 拿它当上界正合适 —— v1 这一路一次都不许多叫。
    const modelCalls = r.run.trace.filter((n) => n.kind === "model").length;
    // 2026-09-05：批判在 v1 / v2 两支都跑（前提被否定跟有没有靶点库无关），上界从 2 抬到 3。
    expect(modelCalls).toBeLessThanOrEqual(3);
    expect(r.doc.quality?.state).toBeDefined();
  });

  it("给了靶点库就走四段，产物上挂得住每一段", async () => {
    const r = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
      watched: ["渠道代理商"],
    });
    const s = r.doc.stages!;
    expect(s.entities.length).toBeGreaterThan(0);
    expect(s.hits[0].target.id).toBe("J-2");
    expect(s.blindspot.proximity).toBe("adjacent");
    // 这两条成立**全靠文件顶上那个 `search.ts` 的桩**：源表里有一个源，但它一条都取不到，
    // 所以一条证据都没入账。桩去掉的话罐头检索源是取得到东西的，这两条就该红 ——
    // 红了要改的是这里的前提（补桩），不是 `search.ts`，也不是往 `verify.ts` 里加开关。
    expect(s.searchless).toBe(true);
    expect(s.evidence).toEqual([]);
    expect(s.impact.proposalType).toBeDefined();
    expect(["discuss", "watch", "dismiss"]).toContain(s.disposition.action);
    expect(s.card.chars).toBeGreaterThan(0);
  });

  it("每一段的产物都挂得上来源", async () => {
    const r = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    const t = r.doc.stages!.disposition.trigger;
    if (t) {
      expect(t.provenance).toEqual({ issueId: "ISS-901", stage: "pre_research" });
      expect(t.status).toBe("proposed");
    }
  });

  it("v2 也不许自动布控 —— 产物里一条 active 都不许有", async () => {
    const r = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    const t = r.doc.stages!.disposition.trigger;
    expect(t === null || t.status === "proposed").toBe(true);
  });

  it("同议题第二次预研出的是增量卡", async () => {
    const first = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    const second = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
      prevStages: first.doc.stages,
    });
    expect(second.doc.stages!.card.kind).toBe("increment");
  });

});

/*
 * 原来这里断言的是 `r.violations.every((x) => typeof x === "string")` —— `violations`
 * 是 `Violation[]`（对象），那个 `typeof` 恒假，`every` 只在空数组上偶然为真，
 * 于是 Step 3 那句 `violations = [...violations, ...cardViolations]` 删掉也照样绿。
 * 这个接头是这一段唯一把卡片机检接上去的地方，得有一条真断言绑住它。
 *
 * 卡的第一段就是模型给的说法本身（装配那边第一段无条件放），**说法多长只有模型说得出来**，
 * 靶点文本、材料都改不动它。所以这一条把 `a3.impact` 那份罐头的 `statement` 换长，
 * 让 A3-14（p0）真的报出来。
 *
 * 打的是**假模型**（`models/mock.ts`），不是 `card.ts` 也不是 `run.ts`：生产模块一个没换，
 * 换的只是「模型这一轮说了什么」。姿态照 `a4/pipeline.test.ts` 里那条「罐头全读不出」来 ——
 * 用 `doMock` + `resetModules` 而不是文件顶上的 `vi.mock`，因为上面那几条用例要的是原来的罐头；
 * 重来一遍模块图之后 `@/lib/ontology/context` 也是新的一份，那一桩要重配一次。
 * （文件顶上 `search.ts` 那一桩是 `vi.mock` 注册的，`resetModules` 之后仍然生效。）
 *
 * **验收标准：把 Step 3 里那句 `violations = [...violations, ...cardViolations];` 删掉，
 * 这一条必须红。它不红，说明卡片机检没接进那份违规清单，Task 11 就没做完。**
 */
describe("卡片机检并进了那一份违规清单", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/models/mock");
    vi.resetModules();
  });

  it("卡真的超了预算时，A3-14 出现在 r.violations 里", async () => {
    vi.doMock("@/lib/models/mock", async () => {
      const actual = await vi.importActual<typeof import("@/lib/models/mock")>("@/lib/models/mock");
      return {
        ...actual,
        mockText: (hint?: string, messages: Parameters<typeof actual.mockText>[1] = []) => {
          const text = actual.mockText(hint, messages);
          if (hint !== "a3.pre-research") return text;
          // 卡上的说法现在就是 verdict（`deriveImpact`）：只把它改长，其余照罐头。
          return JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), verdict: "那条判断要收窄".repeat(60) });
        },
      };
    });
    vi.resetModules();
    const ont = await import("@/lib/ontology/context");
    vi.mocked(ont.openOntologyContext).mockResolvedValue(external);
    const { runPreResearch: run } = await import("./run");

    const r = await run({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    expect(r.violations.some((v) => v.rule === "A3-14")).toBe(true);
  });

  /*
   * 2026-08-29 ISS-115 真跑时踩的那件事：轻量批判那一次的额度给到 1500，Opus 的思考把它
   * 吃光，异常一路穿到最外层 —— 整轮预研判 failed，屏幕上那张卡**连参谋的判断都没有**。
   *
   * 这两条钉的是修完之后的语义：v2 那几段挂了，参谋的判断照样交出来，`stages` 整格不给
   * （而不是给一份半成品），并且记一条 p1 让运营台看得见。**p1 不许升成 p0** ——
   * 升了就等于把一份参谋判断完好的预研整个退回去重跑，而重跑治不好模型挂掉。
   */
  const withTargets = {
    ...V1,
    targets: [{ kind: "judgment" as const, id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
  };

  it("批判挂了：参谋的判断照样交出来，quality 记 criticUnavailable，不当通过（2026-09-05）", async () => {
    const { criticize } = await import("./critic");
    vi.mocked(criticize).mockRejectedValueOnce(new Error("模型输出被 max_tokens(1500) 截断。"));
    const r = await runPreResearch(withTargets);
    // 最值钱的那一样还在 —— 这一条红了说明兜底没起作用，整轮又被拖死了。
    expect(r.doc.take.trim().length).toBeGreaterThan(0);
    // 批判不再是装卡的前置：stages 照样有（影响从结论推导、卡纯函数装配），只是质量状态照实记。
    expect(r.doc.stages).toBeDefined();
    expect(r.doc.quality?.state).toBe("criticUnavailable");
    const v = r.violations.find((x) => x.rule === "S02-D");
    expect(v?.severity).toBe("p1");
    expect(v?.message).toContain("max_tokens(1500)");
    // p1 不挡门。
    expect(r.degraded).toBe(false);
  });

  it("靶点匹配挂了：处置与卡整段跳过，不拿空命中硬凑一份提案", async () => {
    const { matchTargets } = await import("./targets");
    vi.mocked(matchTargets).mockRejectedValueOnce(new Error("模型返回里没有正文。"));
    const r = await runPreResearch(withTargets);
    expect(r.doc.take.trim().length).toBeGreaterThan(0);
    expect(r.doc.stages).toBeUndefined();
    expect(r.violations.find((x) => x.rule === "A3-18")?.message).toContain("靶点匹配");
  });
});
