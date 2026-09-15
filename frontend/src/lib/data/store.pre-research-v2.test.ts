/*
 * 这两个赋值必须是文件里最早的可执行语句：`store.ts` 在模块顶层就读它们
 * （持久化开关、模型开关），任何一个会摸到 store 的 import 早于它们，读到的就是
 * 没设过的值。所以下面只留 `import type` 与 vitest 的 import，真正的模块一律在
 * beforeAll 里 await import。
 *
 * **这个文件是 live 档**（不设 `TKOS_MODE`，`runMode()` 默认就是 live）。
 * live 档下 `store.issues` / `store.cards` / `store.judgments` 里没有这几条用例要的
 * 前置状态，所以这里一律**自己造**，一条种子都不指望。
 *
 * 要种子里那些既有议题与卡的用例（Task 13 / 15 / 16）在另一个文件：
 * `store.pre-research-v2.demo.test.ts`。两个文件分开是因为 `TKOS_MODE` 必须在
 * `store.ts` 被 import 之前定下来，一个进程里定不出两档。
 *
 * **也不要往 `src/lib/data/store.triggers.demo.test.ts` 里加** —— 那个文件测的是
 * 「demo 档两个自动触发点都不起模型」，跟 `store.triggers` 这张表没关系，名字撞了而已。
 */
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { TriggerProposal } from "@/lib/agent/a3/stages";
import type { SearchProvider } from "@/lib/research/search";
import type { api as Api } from "./store";
import type { Judgment } from "./types";

/*
 * 下面那条「预研的产物真进了库」要跑一轮真的预研，而 `runPreResearch` 无条件
 * `openContext` 且 `Harness` 有意原样重抛 —— 离线不打这个桩，第一个 await 就死。
 * 姿态照 `src/lib/agent/harness.external.test.ts`：`vi.importActual` 展开 + 覆盖
 * `openContext`。工厂是懒的，所以它不会抢在上面那两行赋值之前把 store 拉起来。
 */
vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

/*
 * 检索也要打桩，理由不是「离线跑不起来」（`providers()` 在 mock 档回的是罐头源，
 * 取得到东西），而是**那一档下这条测试要断言的东西不确定**：有证据入账就可能凑够
 * 两组独立源，于是处置建议从「待定」变成「探讨」，而只有待定那一档才产出触发器提案。
 * 让源表里那个源一条都取不到，独立源组数恒为 0，处置恒是待定 —— 那正是缺 key 时
 * 生产上的行为。这是测试侧打桩，`src/lib/research/search.ts` 一字未动；
 * `NoSearch` 那个 class 没有导出，为测试去导出它就是改那个文件（硬约束禁止），
 * 所以这里自己拿一个同形状的源顶上。
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

let api: typeof Api;
let store: typeof import("./store");

beforeAll(async () => {
  /*
   * **顺序是硬的：消费方先进模块缓存，被打桩的那个模块后取。**
   * 反过来先 `await import("@/lib/ontology/context")` 的话，`vi.importActual` 会把真模块
   * 塞进缓存，随后 `store.ts` → `harness.ts` 那条边取到的就是真的 `openContext`，
   * 离线第一个 await 当场抛 GraphKnowledgeUnavailable。这条坑
   * `src/lib/agent/harness.external.test.ts` 的文件头注释里写着。
   */
  store = await import("./store");
  api = store.api;

  const { openOntologyContext } = await import("@/lib/ontology/context");
  vi.mocked(openOntologyContext).mockResolvedValue({
    mode: "external_only",
    bundle: null,
    anchor: null,
    noAnchorReason: "离线：这一池分不出高低",
    staticContext: "",
    snapshotId: null,
    trace: [{ at: "2026-08-27T00:00:00.000Z", label: "P3 候选池", kind: "graph", detail: {} }],
    warnings: [],
  } as unknown as Awaited<ReturnType<typeof openOntologyContext>>);
});

function proposal(over: Partial<TriggerProposal> = {}): TriggerProposal {
  return {
    id: "TG-ISS-901-1",
    condition: "那家公司公布了国内客户名单",
    targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
    source: "watch",
    onFire: "proposeDiscuss",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "proposed",
    provenance: { issueId: "ISS-901", stage: "pre_research" },
    ...over,
  };
}

/**
 * 靶点库是从 `store.judgments` map 出来的，而 live 档下那张表里没有这一条。
 * 这条判断的正文要和下面那个议题标题有字面重叠 —— `narrowTargets` 按二元组重叠预筛，
 * 重叠为 0 的靶点根本进不了送给模型的候选清单。编号必须是 `J-2`：罐头
 * （`mock.ts` 的 `a3.targets`）回的命中就是这个编号，清单上没有的编号会被丢掉。
 */
function judgment(): Judgment {
  return {
    id: "J-2",
    domainId: "01",
    kind: "hypothesis",
    statement: "国内做 agent 编排的公司今年不会有新玩家",
    version: 1,
    standing: "unverified",
    confirmedBy: "",
    confirmedAt: "2026-01-01T00:00:00.000Z",
    freshUntil: "2099-01-01T00:00:00.000Z",
    basis: [],
    revisions: [],
    reopenTriggers: [],
    shakenBy: [],
    verifiedByTasks: 0,
  };
}

/** 等这一轮预研跑到不再是 running。全程进程内的假模型，正常几十毫秒就到。 */
const settle = async (issueId: string) => {
  for (let i = 0; i < 200; i++) {
    const st = await api.preResearchStatus(issueId);
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("预研四秒还没跑完 —— 假模型下不该发生");
};

describe("触发器表", () => {
  it("空表读得出来，不是 undefined", async () => {
    expect(Array.isArray(await api.listTriggers())).toBe(true);
  });

  it("读表时顺手把过期的清成 expired", async () => {
    store.__seedTriggerForTest(
      proposal({ id: "TG-X-1", status: "active", expiresAt: "2020-01-01T00:00:00.000Z" })
    );
    const list = await api.listTriggers();
    expect(list.find((t) => t.id === "TG-X-1")!.status).toBe("expired");
  });

  it("已经开过火的那条不会被清扫改掉", async () => {
    store.__seedTriggerForTest(proposal({
      id: "TG-X-2", status: "fired", firedAt: "2021-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:00.000Z",
    }));
    const list = await api.listTriggers();
    expect(list.find((t) => t.id === "TG-X-2")!.status).toBe("fired");
  });
});

/*
 * 这一段测的是那个生产接头本身：靶点库真喂进了那一轮，那一轮的触发器提案
 * 真进了表，上一轮的 stages 真从 `preResearchPrev` 喂了回去。
 *
 * 为什么非要有它：这三件事此前一条断言都没有 —— 把那两处接头整段删掉，
 * 其余每一条测试照样绿。而这几行正是预研跟库之间唯一的接头。
 *
 * 两轮写在同一条用例里，因为第二轮的前置状态就是第一轮的产物：分成两条用例
 * 就得靠执行顺序传状态，那种耦合下一个人一改就断。
 */
describe("预研跑完之后：靶点喂进去、提案进表", () => {
  it("跑一轮真的预研 —— 靶点库进了那一轮，触发器提案落进表且是 proposed；第二轮出增量卡", async () => {
    /*
     * 判断要在 `addIssue` **之前**塞进去：那个方法落卡之后当场就叫
     * `ensurePreResearch`，而靶点库是在那一刻 map 出来的，晚一步就赶不上这一轮。
     */
    store.__seedJudgmentForTest(judgment());

    const issue = await api.addIssue("智谱 AI 公布了国内客户名单，今年还会不会有新玩家");
    const first = await settle(issue.id);
    expect(first.status).toBe("done");

    /*
     * 靶点这一格：命中里有 `J-2`，就说明 `targets: buildTargetIndex()` 真的传下去了 ——
     * 不传的话 `runPreResearch` 走的是 v1 那一路，`stages` 整格都是 `undefined`。
     *
     * `__advancePreResearchRoundForTest` 顺手把这份 `stages` 搬到 `preResearchPrev`、
     * 删掉 `preResearch[issueId]`（就是 Task 15 `attachSignalToCard` 的那两步手动动作），
     * 断言完这一段就已经站在第二轮该在的起点上了。
     */
    const stages = store.__advancePreResearchRoundForTest(issue.id);
    expect(stages).toBeDefined();
    expect(stages!.hits.map((h) => h.target.id)).toContain("J-2");

    /*
     * 提案这一格：进了表，而且是 `proposed`。**`active` 一条都不许有** ——
     * 转 active 只发生在他按下待定那一下。走 `listTriggers()` 这个只读
     * 生产入口断言，不直接摸 `store.triggers`。
     */
    const mine = (await api.listTriggers()).filter((t) => t.provenance.issueId === issue.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id.startsWith("TG-")).toBe(true);
    expect(mine[0]!.status).toBe("proposed");
    /*
     * 只查这一轮自己产出的那几条，不查整张表：上面那几条用例往表里塞过一条
     * `status: "active"` 的假数据（测清扫用的），对整张表断言「没有 active」
     * 会绿在别的用例的执行顺序上，而不是绿在这一条要证明的事情上。
     */
    expect(mine.some((t) => t.status === "active")).toBe(false);

    /*
     * 第二轮：从同一个公开入口再跑一轮。出的是增量卡，就说明 `prevStages`
     * 那一格真的读的是 `preResearchPrev`（上一步 `__advancePreResearchRoundForTest`
     * 已经把它摆到位）。
     */
    await api.startPreResearch(issue.id);
    const second = await settle(issue.id);
    expect(second.status).toBe("done");
    const afterStages = store.__advancePreResearchRoundForTest(issue.id);
    expect(afterStages!.card.kind).toBe("increment");
  });
});
