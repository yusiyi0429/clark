/**
 * `runA1a` 的三条路：`update_issue` / `new_issue` / `ignore`，加上纯外部那条和
 * 路由取值不合法那条。
 *
 * 断的是**控制流**，不是模型质量：哪条路调几次模型、`ignore` 会不会白花第二次
 * 调用、纯外部时会不会去做「取代」、路由看不懂时会不会硬着头皮往下走。这些错了
 * 都不会报错 —— 产出照样是一份格式完整的议题，只是走错了路。
 *
 * 两处打桩：图谱那扇门（`openContext`）和模型那一层（`callModelJson`）。模型
 * 要打桩是因为 `TKOS_MODEL_MOCK=1` 的罐头只有一份、路由值写死是 `new_issue`，
 * steer 不到另外两条路。`assemble` 用真的 —— 顺带证明这几个 prompt key 的
 * md 文件确实在。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CallResult } from "@/lib/models/complete";

vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));
vi.mock("@/lib/agent/json", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/json")>("@/lib/agent/json");
  return { ...actual, callModelJson: vi.fn() };
});

// 双保险：桩万一没生效，也不许出网。
process.env.TKOS_MODEL_MOCK = "1";

/*
 * **顺序要紧**：先加载消费方（`./run` → harness），再取桩的把手。
 * 反过来的话，工厂里那次 `importActual` 会先把真模块塞进缓存，之后 harness
 * 拿到的就是真的 `openContext` —— 桩在测试文件这边看着是装上了
 * （`vi.isMockFunction` 为 true），实际调用的却是真链路，于是测试红在
 * 「连不上图服务」而不是它要断的那件事上。
 */
const { runA1a } = await import("./run");
const { openOntologyContext } = await import("@/lib/ontology/context");
const { callModelJson } = await import("@/lib/agent/json");

const mockedOpen = vi.mocked(openOntologyContext);
const mockedCall = vi.mocked(callModelJson);

type Opened = Awaited<ReturnType<typeof openOntologyContext>>;

const anchored = {
  mode: "anchored",
  bundle: {
    recipe: "S01",
    anchorCode: "CARD-01",
    memberIds: ["member:iss-1"],
    renderedMarkdown: "既有议题：模型能力对比 [member:iss-1]",
    viewer: "PSN-01",
    asOf: "2026-08-19",
    sourceBaseUrl: "https://example.invalid/graph",
  },
  anchor: null,
  noAnchorReason: null,
  staticContext: "",
  snapshotId: "ctx-a1a",
  trace: [],
  warnings: [],
} as unknown as Opened;

const externalOnly = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "图谱里没有与这条信号对应的锚点",
  staticContext: "",
  snapshotId: null,
  trace: [],
  warnings: [],
} as unknown as Opened;

const reply = (payload: unknown): CallResult => ({
  text: JSON.stringify(payload),
  usage: { inputTokens: 10, outputTokens: 20, cachedInputTokens: 0, reasoningTokens: 0 },
  ms: 1,
  queuedMs: 0,
  slot: "pro",
  alias: "test-alias",
  providerModelId: "test-model",
  effortSent: null,
  stopReason: "stop",
});

/** 按 `hint`（= prompt key）分派，跟真链路一样。没登记的 key 就是没想到，直接红。 */
function answers(table: Record<string, unknown>): void {
  mockedCall.mockImplementation(async (_messages, opts = {}) => {
    const key = opts.hint ?? "";
    if (!(key in table)) throw new Error(`用例没有为 ${key || "（未给 hint）"} 准备回答`);
    return reply(table[key]);
  });
}

const modelCalls = (rec: Awaited<ReturnType<typeof runA1a>>): string[] =>
  rec.trace.filter((n) => n.kind === "model").map((n) => String(n.detail.promptKey ?? ""));

const input = {
  cardId: "CARD-01",
  headline: "大厂把 To B 的销售与交付合并成行业线",
  source: "公开报道",
  body: "大厂把 To B 的销售与交付合并成行业线，入口从模型能力挪到了行业交付。",
};

const TRIAGE_NEW = {
  decision: "new_issue",
  signal_reading: "入口从能力侧移到交付侧。",
  target_issue_code: "",
  rationale: "现有议题说的是能力对比，不是入口归属。",
};

describe("runA1a 的三条路", () => {
  beforeEach(() => {
    mockedOpen.mockReset();
    mockedCall.mockReset();
    mockedOpen.mockResolvedValue(anchored);
  });

  it("new_issue：选路 + 写正文两次调用，选路结论跟着产出一起交出去", async () => {
    answers({
      "a1a.triage": TRIAGE_NEW,
      "a1a.issue.new": {
        decision: "new_issue",
        issue_statement: "入口移到交付侧之后，我们靠模型能力建立的差异还剩多少？",
        cited_member_ids: [],
      },
    });

    const rec = await runA1a(input);

    expect(rec.status).toBe("ok");
    expect(rec.route).toBe("new_issue");
    expect(modelCalls(rec)).toEqual(["a1a.triage", "a1a.issue.new"]);
    // 评这份议题写得对不对，前提是先看到它为什么走了这条路。
    expect(rec.output?.triage).toMatchObject({ decision: "new_issue" });
    expect(rec.contextMode).toBe("anchored");
    expect(rec.contextAnchor).toBe("CARD-01");
  });

  it("update_issue：第二次调用漏了被取代的编号，用选路那一步指的那条补回去", async () => {
    // 空的 target_issue_code 会让写回找不到要取代谁，而产出本身看起来完全正常。
    answers({
      "a1a.triage": {
        decision: "取代",
        signal_reading: "说的还是同一件事，边界变了。",
        target_issue_code: "ISS-7",
        rationale: "范围从三个行业收窄到一个。",
      },
      "a1a.issue.update": {
        issue_statement: "把范围从三个行业收窄到一个之后，这条议题还成立吗？",
        target_issue_code: "   ",
        cited_member_ids: [],
      },
    });

    const rec = await runA1a(input);

    expect(rec.route).toBe("update_issue");
    expect(modelCalls(rec)).toEqual(["a1a.triage", "a1a.issue.update"]);
    expect(rec.output?.target_issue_code).toBe("ISS-7");
    // 归一化过的路由值要留痕：下游按三个正式值分支，Prompt 里就该定死。
    expect(rec.checks.some((c) => c.name === "路由取值原样合法" && !c.ok)).toBe(true);
  });

  it("ignore：选路那一步就结束，不再调第二次模型；空产出是正确结果", async () => {
    answers({
      "a1a.triage": {
        decision: "噪音",
        signal_reading: "同一条公开报道的二次转述。",
        target_issue_code: "",
        rationale: "没有新增任何事实，量大只是转载多。",
      },
    });

    const rec = await runA1a(input);

    expect(rec.status).toBe("ignored");
    expect(rec.route).toBe("ignore");
    // 第二次调用是这条路上最容易白花的钱：这次运行的产出**就是**那个判断。
    expect(modelCalls(rec)).toEqual(["a1a.triage"]);
    expect(rec.output).toMatchObject({ decision: "ignore" });
  });

  it("纯外部：不选路，一次调用判完 —— 那条路上「取代」根本不成立", async () => {
    mockedOpen.mockResolvedValue(externalOnly);
    answers({
      "a1a.issue.external": {
        issue_statement: "入口从能力侧移到交付侧之后，谁必须重新考虑自己在做什么？",
        why_it_qualifies: "它指向采购决策权的转移，不是一次性事件，也不是执行层面的操作问题。",
        cited_member_ids: [],
      },
    });

    const rec = await runA1a(input);

    expect(rec.status).toBe("ok");
    expect(rec.route).toBe("new_issue");
    expect(modelCalls(rec)).toEqual(["a1a.issue.external"]);
    expect(rec.contextMode).toBe("external_only");
    expect(rec.trace.some((n) => n.label === "纯外部 · 跳过选路")).toBe(true);
    // 台账要看得出「这次试的是哪个配方」—— 纯外部路没有 bundle，从 bundle 取会是空串。
    expect(rec.contextRecipe).toBe("S01");
    expect(rec.contextAnchor).toBe("");
  });

  it("纯外部且判为噪音：不硬造一条议题出来", async () => {
    mockedOpen.mockResolvedValue(externalOnly);
    answers({
      "a1a.issue.external": { relevant: false, reason: "这条只是转述，没有新增事实。" },
    });

    const rec = await runA1a(input);

    expect(rec.status).toBe("ignored");
    expect(rec.route).toBe("ignore");
    expect(rec.output?.decision).toBe("ignore");
  });

  it("路由取值看不懂：就地失败，不挑一条往下走", async () => {
    answers({ "a1a.triage": { decision: "也许吧", signal_reading: "说不清。" } });

    const rec = await runA1a(input);

    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("路由取值不合法");
    expect(rec.error).toContain("也许吧");
    expect(modelCalls(rec)).toEqual(["a1a.triage"]);
    expect(rec.route).toBeUndefined();
  });
});
