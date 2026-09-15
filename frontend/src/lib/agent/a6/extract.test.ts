/**
 * A6 一轮萃取的出口。打桩模型调用 —— 这里要锁的全是**模型答完之后**的处置：
 * 什么都没发生算不算一次运行、写不出依据 / 写不出 from→to 的那一条落在哪儿、
 * 他说要确认却没给理由时会不会被放过去、台账上认不认得出这条链路从来没开过上下文。
 *
 * 这些错法一个症状都没有：板上少一条、或者多一条不该有的，屏幕上什么都不显示。
 * 而「他没给理由也算确认」那一条错下去，是系统替他完成了一次权力转移。
 *
 * 打桩注意（同 `harness.external.test.ts`）：先静态 import 被测的消费方，再动态
 * import 被 mock 的模块 —— 顺序反了，`vi.importActual` 会把真模块塞进模块缓存。
 */
import { describe, expect, it, vi } from "vitest";

import { extractTurn, type ExtractInput } from "./extract";

vi.mock("@/lib/agent/json", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/json")>("@/lib/agent/json");
  return { ...actual, callModelJson: vi.fn() };
});

const { callModelJson } = await import("@/lib/agent/json");
const mocked = vi.mocked(callModelJson);

type Reply = Awaited<ReturnType<typeof callModelJson>>;

function answer(body: Record<string, unknown>): void {
  mocked.mockReset();
  mocked.mockResolvedValue({
    text: JSON.stringify(body),
    usage: { inputTokens: 12, outputTokens: 34, cachedInputTokens: 0, reasoningTokens: 0 },
    ms: 7,
    slot: "flash",
    alias: "doubao-flash",
    providerModelId: "mock-flash",
    effortSent: null,
    stopReason: "stop",
  } as unknown as Reply);
}

const input: ExtractInput = {
  issueTitle: "入口移到交付侧之后我们还剩什么",
  currentStatement: "我们赌的是模型能力足以带动交付。",
  currentVersion: 3,
  ceoTurn: "那客户侧的合规呢？",
  agentTurn: "补一个数：两个已投标客户的决策人换成了业务线负责人。",
  board: [
    {
      ref: "R1",
      id: "BJ-ISS-014-research-1",
      label: "当前赌注",
      statement: "我们赌的是模型能力足以带动交付。",
      confirmed: false,
    },
    {
      ref: "R2",
      id: "BJ-ISS-014-research-2",
      label: "战略边界",
      statement: "交付侧的系统集成不自己做。",
      confirmed: true,
    },
  ],
};

/** 一条形状完整的新判断。各条测试只改自己要考的那一个字段。 */
const formed = (over: Record<string, unknown> = {}) => ({
  label: "合规准入前置",
  statement: "合规准入是交付速度的前提，不是它的下游成本。",
  basis: "两个已投标客户的决策人换成了业务线负责人。",
  boundary: "只说准入顺序，不说合规要投多少人。",
  reopenIf: "出现一个绕过准入直接交付成功的客户。",
  by: "agent",
  replaces: null,
  changeLabel: "",
  changeFrom: "",
  changeTo: "",
  ...over,
});

describe("A6 一轮萃取", () => {
  it("什么都没发生是 ignored 而不是 ok —— 十四轮里落了几轮，靠这个数得出来", async () => {
    answer({ formed: [], confirms: [], ceoChallenge: "那客户侧的合规呢？", aside: null });

    const { outcome, run } = await extractTurn(input);

    expect(outcome.formed).toHaveLength(0);
    expect(outcome.confirms).toHaveLength(0);
    expect(run.agent).toBe("A6");
    expect(run.status).toBe("ignored");
    expect(run.input).toBe("入口移到交付侧之后我们还剩什么 · 板上 2 条");
    // 每一轮都入账，包括什么都不做的那些：usage 记的是真花掉的 token。
    expect(run.usage.outputTokens).toBe(34);
  });

  it("台账上认得出这条链路**从来没开过**上下文，不是开了没锚上", async () => {
    answer({ formed: [], confirms: [] });

    const { run } = await extractTurn(input);

    // 空串 = 没调过 openContext；`external_only` = 调了但图里没有对应议题。
    expect(run.contextMode).toBe("");
    expect(run.contextRecipe).toBe("");
    expect(run.snapshotId).toBe("");
    expect(run.trace.some((n) => n.kind === "graph")).toBe(false);
  });

  it("写不出依据的那一条不上板 —— 板上一句没有依据的话就是一句口号", async () => {
    answer({ formed: [formed({ basis: "" })], confirms: [] });

    const { outcome, run } = await extractTurn(input);

    expect(outcome.formed).toHaveLength(0);
    expect(run.status).toBe("ignored");
    expect(run.trace.some((n) => n.label.includes("写不出依据"))).toBe(true);
  });

  it("说改写了板上某一条却写不出 from→to，整条丢掉并留痕", async () => {
    answer({
      formed: [formed({ replaces: "R1", changeFrom: "", changeTo: "" })],
      confirms: [],
    });

    const { outcome, run } = await extractTurn(input);

    expect(outcome.formed).toHaveLength(0);
    expect(run.status).toBe("ignored");
    // 屏幕上这一支和「模型判什么都没发生」一模一样，台账上必须分得开。
    expect(run.trace.some((n) => n.label.includes("按「没改」处理"))).toBe(true);
  });

  it("编号指到板上没有的那一条时，判断本身还在，只是不算改写", async () => {
    answer({
      formed: [formed({ replaces: "9", changeFrom: "旧前提", changeTo: "新前提" })],
      confirms: [],
    });

    const { outcome, run } = await extractTurn(input);

    expect(outcome.formed).toHaveLength(1);
    expect(outcome.formed[0].replaces).toBeNull();
    // 不改写就没有「变化」那一行 —— 留着它，板上会出现一个指不到对家的箭头。
    expect(outcome.formed[0].changeFrom).toBe("");
    expect(run.trace.some((n) => n.label.includes("编号指不到"))).toBe(true);
  });

  it("真的改写了板上某一条：replaces 是真 id，status 是 ok，违规只记不挡", async () => {
    answer({
      formed: [
        formed({
          statement: "在原判断基础上，合规准入先于交付速度。",
          replaces: "第 1 条",
          changeLabel: "前提替换",
          changeFrom: "赌交付速度能带动成单这一条前提",
          changeTo: "合规准入",
        }),
      ],
      confirms: [],
      ceoChallenge: "合规扛不住的话，交付再快也进不去。",
      aside: { text: "谁来做这件事", why: "扣着同一件议题的落地路径" },
    });

    const { outcome, run } = await extractTurn(input);

    // 模型只写数字、写「第 1 条」都要认得出来，落库的是真 id。
    expect(outcome.formed[0].replaces).toBe("BJ-ISS-014-research-1");
    expect(outcome.formed[0].changeLabel).toBe("前提替换");
    expect(outcome.aside?.text).toBe("谁来做这件事");
    expect(run.status).toBe("ok");
    // 违规只记不挡 —— 挡了板上就少一条，那更糟。
    expect(run.violations?.some((v) => v.startsWith("A6X-01"))).toBe(true);
    expect(run.violations?.some((v) => v.startsWith("A6X-02"))).toBe(true);
  });

  it("他说要确认却没给理由 —— 不算确认，等参谋把那一句问出来", async () => {
    answer({ formed: [], confirms: [{ ref: "1", support: "" }] });

    const { outcome, run } = await extractTurn(input);

    expect(outcome.confirms).toHaveLength(0);
    expect(run.status).toBe("ignored");
    expect(run.trace.some((n) => n.label.includes("没说凭什么"))).toBe(true);
  });

  it("给了理由才算确认，落的是真 id；已经在下半层的那一条静静跳过", async () => {
    answer({
      formed: [],
      confirms: [
        { ref: "1", support: "两个客户的决策人都换了，这条赌注的前提已经不在了。" },
        { ref: "2", support: "这条早就定了。" },
      ],
    });

    const { outcome, run } = await extractTurn(input);

    expect(outcome.confirms).toHaveLength(1);
    expect(outcome.confirms[0].id).toBe("BJ-ISS-014-research-1");
    // 确认也是产出 —— 这一轮不能记成 ignored，否则台账答不出「他在对谈里确认过几条」。
    expect(run.status).toBe("ok");
  });

  it("一轮里交太多条只取前两条 —— 板的全部价值在于它短", async () => {
    answer({
      formed: [
        formed({ statement: "第一条。" }),
        formed({ statement: "第二条。" }),
        formed({ statement: "第三条。" }),
      ],
      confirms: [],
    });

    const { outcome, run } = await extractTurn(input);

    expect(outcome.formed).toHaveLength(2);
    expect(run.trace.some((n) => n.label.includes("太多条判断"))).toBe(true);
  });
});
