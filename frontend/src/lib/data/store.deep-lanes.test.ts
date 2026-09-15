// 必须在 import 之前设置（同 store.no-evidence.test.ts）：不设 TKOS_PERSIST=0，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 深研完成那条事件里，**那几栏到底是什么**。
 *
 * 这一条钉的是 2026-08-26 那次改编排：`A4Evidencing.lanes` 原来一条 = 一个模型各跑一整套
 * 研究（各自写报告、各自过出口对账，判断板只认其中一份），换成七步链之后一条 = 一批维度的
 * 取证方向 —— 命题和取证按方向分，但 `writeStaged` 只跑一次、`auditExit` 只跑一次、报告区
 * 只有一栏。两种编排下 `lanes.length` 都是 4，所以那句话不改的话，运营台读到的是
 * 「这一轮四条各跑了一整套深研、各自写报告、各自过出口对账」，也就是四次交叉确认 ——
 * 而这一轮一次都没做。屏幕上那句话是唯一说出这件事的地方，所以它自己要有测。
 *
 * 两支都断言：新那一支说对了不算完，老那一支的原话一个字不许动（四链路那条编排还在，
 * 只是不默认开）。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { api as Api } from "./store";
import type { AgentRunRecord, ResearchDoc } from "./types";

const { fixture } = vi.hoisted(() => ({
  fixture: {
    /** 置 true 走「一条 = 一批维度的取证方向」那一支。用例里改它。 */
    byDimension: false as boolean | undefined,
  },
}));

const LANE_LABELS = ["需求与供给", "技术与上游", "格局", "政策、风险与主体"];

vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (input: { issueId: string; title: string }) => {
    const doc: ResearchDoc = {
      issueId: input.issueId,
      judgment: [{ text: "卡在预算口径，不是系统选型。", traces: [] }],
      keyEvidence: [{ text: "四个域的口径各自独立。", traces: [] }],
      counters: [{ text: "也可能只是这一期排期紧。", traces: [] }],
      unknowns: [{ text: "外部同行怎么切，本轮没能核。", traces: [] }],
      routeSuggestion: "进议题研究",
      byAgentLabel: "您的 Agent",
      assembledFrom: [{ label: "外部检索 · 博查（4 轮，入账 12 条证据）" }],
      sourceText: "## 判断\n先说结论：卡在预算口径。",
      sourceLabel: "深研 v2",
    };
    const run = {
      id: `run-a4-${input.issueId}`,
      agent: "A4",
      status: "ok",
      input: input.title,
      output: null,
      contextMode: "external_only",
      trace: [],
      checks: [],
      checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
      usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      slot: "pro",
      modelAlias: "deepseek-v4-pro",
      providerModelId: "deepseek-v4-pro",
      depth: "",
      snapshotId: "",
      contextRecipe: "",
      contextAnchor: "",
      contextViewer: "",
      contextAsOf: "",
      graphknowledgeBaseUrl: "",
      warnings: [],
      createdAt: "2026-08-26T04:23:00.000Z",
      finishedAt: "2026-08-26T04:41:00.000Z",
      latencyMs: 1_080_000,
    } as unknown as AgentRunRecord;
    return {
      doc,
      violations: [],
      attempts: 1,
      degraded: false,
      challengeCount: 0,
      challenged: false,
      evidencing: {
        provider: "bocha",
        providerLabel: "博查",
        hitsByProvider: { bocha: { label: "博查", returned: 30, unique: 24 } },
        propositions: 8,
        rounds: [],
        recorded: 12,
        rejected: 5,
        unresolved: [],
        calculations: [],
        citationsBound: 6,
        reportAttempts: 1,
        lanes: LANE_LABELS.map((label, i) => ({
          label,
          modelAlias: "v2",
          primary: i === 0,
          propositions: 2,
          rounds: 1,
          recorded: 3,
          rejected: 1,
          unresolved: [],
          attempts: 1,
          blocked: 0,
        })),
        ...(fixture.byDimension === undefined ? {} : { lanesAreDimensions: fixture.byDimension }),
      },
      run,
    };
  },
}));

let api: typeof Api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

/** 等那一轮落定。轮询而不是定长 sleep：慢一点的机器上定长会假失败。 */
const settle = async (issueId: string) => {
  for (let i = 0; i < 100; i += 1) {
    const st = await api.deepResearchStatus(issueId);
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("那一轮两秒还没落定 —— 假 A4 下不该发生");
};

const detailOf = async (title: string): Promise<string> => {
  const issue = await api.addIssue(title);
  await api.startDeepResearch(issue.id);
  expect((await settle(issue.id)).status).toBe("done");
  const ev = (await api.getTimeline(issue.id)).find((e) => e.id === `E-${issue.id}-deep-done`);
  return ev?.detail ?? "";
};

describe("深研完成事件里那几栏说的是什么", () => {
  it("一条 = 一批维度的取证方向时，不许说成四份报告、四遍出口对账", async () => {
    fixture.byDimension = true;
    const detail = await detailOf("AI 转型：预算口径要不要按域重切");

    // 说的是这一轮真做过的事：取证分了方向，报告只有一份。
    expect(detail).toContain(`把取证分到 ${LANE_LABELS.length} 个方向`);
    expect(detail).toContain("报告只有一份");
    for (const label of LANE_LABELS) expect(detail).toContain(label);

    // 这三句一句都不许出现：它们各自都在说「做过 N 次独立确认」。
    expect(detail).not.toContain("各跑了一整套深研");
    expect(detail).not.toContain("各自写报告");
    // 逐栏的成文/出口对账也不许有 —— 全轮那一个数在上一行已经写过一次。
    expect(detail).not.toContain("过了出口对账");
    expect(detail).not.toContain("一遍成文");
    // 只有一份报告，「判断板只认哪一份」这句话在这里没有指称。
    expect(detail).not.toContain("判断板和上面那四节");
  });

  it("四链路那一支的原话一个字不动", async () => {
    fixture.byDimension = undefined; // 老运行落库的记录里压根没有这一栏。
    const detail = await detailOf("AI 转型：ERP 中台化的根因在哪一层");

    expect(detail).toContain(
      `这一轮 ${LANE_LABELS.length} 条链路各跑了一整套深研（各自编命题、各自联网取证、各自写报告、各自过出口对账），报告区分栏摆着：`
    );
    expect(detail).toContain("需求与供给 编 2 条命题、跑 1 轮、入账 3 条、一遍成文、过了出口对账");
    expect(detail).toContain("判断板和上面那四节只从「需求与供给」那一份压出来。");
    expect(detail).not.toContain("把取证分到");
  });
});
