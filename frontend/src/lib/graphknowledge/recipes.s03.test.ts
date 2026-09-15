/**
 * `buildS03` —— 三条配方里最重的那条：两次 P3、双路合并去重、版本链渲染、共识段。
 *
 * 为什么单独给它一个文件：这条路上每一件事错了都**不会报错**，只会让上下文少一
 * 段或多一段，而屏幕上看着完全正常。P3 参数写错 → 召回多了或少了；合并顺序错 →
 * 模型先看到次相关的那条；版本链只渲染最新版 → 判断的演进史消失；共识段漏掉边界
 * → 模型会把一条有边界的共识当无条件成立。
 *
 * 客户端打成固定返回：这里要验的是**装配逻辑**，不是图服务。
 */
import { describe, expect, it } from "vitest";

import type { GkDynamic, GkEntity, GraphKnowledgeClient } from "./client";
import { buildS03 } from "./recipes";

type P3Call = { q: string; k: number; budget: number };

const ENTITIES: Record<string, GkEntity> = {
  "ISS-9": {
    code: "ISS-9",
    label: "入口移到交付侧之后，模型能力还是不是我们的护城河",
    properties: { state: "研讨中" },
    relations: { hasJudgement: ["JDG-3"], resolvedBy: ["AGR-2"], researchForOf: ["RES-5"] },
  },
  "AGR-2": {
    code: "AGR-2",
    label: "行业线先只做金融",
    properties: {
      agreementStatus: "active",
      text: "先在金融一个行业把交付做深，不同时开三个行业。",
      boundary: "只在 2026 年内成立；金融行业线毛利率跌破 40% 就重开。",
    },
  },
  "RES-5": {
    code: "RES-5",
    label: "交付侧入口调研",
    properties: { text: "六家客户里五家的入口已经在交付团队。" },
  },
};

const CHAINS: Record<string, GkEntity> = {
  "JDG-3": {
    code: "JDG-3",
    versions: [
      {
        index: 1,
        status: "superseded",
        at: "2026-03-04T00:00:00Z",
        statement: "模型能力差异足以支撑溢价。",
      },
      {
        index: 2,
        status: "active",
        at: "2026-07-02T00:00:00Z",
        statement: "溢价来自交付确定性，能力差异只是入场券。",
        meetingLabel: "7 月战略会",
      },
    ],
  },
};

const CORE = "入口移到交付侧之后，我们靠模型能力建立的差异还剩多少";

/** 两路 P3 的固定返回，按 k 分派 —— k 就是这两路的身份证（10 = core question，5 = 议题标题）。 */
const P3: Record<number, GkDynamic> = {
  10: {
    query: CORE,
    seeds: [
      { code: "MEM-1", type: "Judgement", score: 0.81 },
      { code: "MEM-2", type: "Agreement", score: 0.44 },
    ],
    text: "core question 路的语义正文。",
  },
  5: {
    query: ENTITIES["ISS-9"].label,
    seeds: [
      { code: "MEM-2", type: "Agreement", score: 0.77 },
      { code: "MEM-3", type: "Research", score: 0.52 },
    ],
    text: "议题标题路的语义正文。",
  },
};

function fake(p3: Record<number, GkDynamic> = P3) {
  const p3Calls: P3Call[] = [];
  const client = {
    baseUrl: "https://example.invalid/graph",
    staticContext: async () => "毛利率 41%，现金覆盖 9 个月。",
    entity: async (code: string) => ENTITIES[code] ?? { code },
    chain: async (code: string) => CHAINS[code] ?? { code },
    dynamic: async (q: string, opts: { k: number; budget: number }) => {
      p3Calls.push({ q, k: opts.k, budget: opts.budget });
      return p3[opts.k] ?? { query: q, seeds: [], warning: "no_route" };
    },
  } as unknown as GraphKnowledgeClient;
  return { client, p3Calls };
}

const build = (client: GraphKnowledgeClient) =>
  buildS03(client, "ISS-9", { coreQuestion: CORE, viewer: "PSN-01", asOf: "2026-08-19" });

describe("buildS03", () => {
  it("两次 P3 的参数逐字对齐：core question (10, 6000)、议题标题 (5, 3000)", async () => {
    const { client, p3Calls } = fake();
    await build(client);

    // 顺序也是约定的一部分：合并时并列最高分取第一路。
    expect(p3Calls).toEqual([
      { q: CORE, k: 10, budget: 6000 },
      { q: ENTITIES["ISS-9"].label, k: 5, budget: 3000 },
    ]);
  });

  it("双路合并：同一个 code 取高分那次，按分数降序，正文用首名分数更高的那一路", async () => {
    const { client } = fake();
    const b = await build(client);
    const seg = b.renderedMarkdown.slice(b.renderedMarkdown.indexOf("【语义召回 · 双路合并】"));

    // MEM-2 两路都召回了（0.44 / 0.77），合并后必须是 0.77 那次。
    expect(seg).toContain("· MEM-2 [Agreement] score=0.770");
    expect(seg).not.toContain("score=0.440");
    // 顺序就是模型的阅读顺序：先看到次相关的那条，推理会跟着它走。
    expect(seg.indexOf("MEM-1")).toBeLessThan(seg.indexOf("MEM-2"));
    expect(seg.indexOf("MEM-2")).toBeLessThan(seg.indexOf("MEM-3"));
    expect(seg).toContain("正文采用得分最高路由：core question");
    expect(seg).toContain("core question 路的语义正文。");
    // 只有一路的正文进上下文，另一路的 seeds 已经合并进列表，正文不重复塞。
    expect(seg).not.toContain("议题标题路的语义正文。");
  });

  it("一路降级：不静默少一段，降级说出来，正文用还活着的那一路", async () => {
    const { client } = fake({
      10: { query: CORE, seeds: [], warning: "query_embedding_not_cached" },
      5: P3[5],
    });
    const b = await build(client);

    expect(b.renderedMarkdown).toContain("降级：core question: query_embedding_not_cached");
    expect(b.renderedMarkdown).toContain("正文采用得分最高路由：议题标题");
    expect(b.warnings).toContain("query_embedding_not_cached");
  });

  it("判断演进链渲染全部版本，不只是最新版；会议标签跟着走", async () => {
    const { client } = fake();
    const b = await build(client);

    expect(b.renderedMarkdown).toContain("v1[superseded] 2026-03-04");
    expect(b.renderedMarkdown).toContain("模型能力差异足以支撑溢价。");
    expect(b.renderedMarkdown).toContain("v2[active] 2026-07-02（7 月战略会）");
  });

  it("共识段带边界 —— 少了边界，一条有条件的共识会被读成无条件成立", async () => {
    const { client } = fake();
    const b = await build(client);

    expect(b.renderedMarkdown).toContain("AGR-2「行业线先只做金融」status=active");
    expect(b.renderedMarkdown).toContain("边界：只在 2026 年内成立");
    expect(b.renderedMarkdown).toContain("【既有研究】");
    expect(b.renderedMarkdown).toContain("六家客户里五家的入口已经在交付团队。");
  });

  it("memberIds 是这次摸到的全部实体：P1/P2 的卡与两路 seeds 都在", async () => {
    const { client } = fake();
    const b = await build(client);

    // 这份表是 A3/A4「引用 ID 真实」自检的白名单：漏一个，正确的引用会被判成编的。
    expect(b.memberIds).toEqual(
      ["AGR-2", "ISS-9", "JDG-3", "MEM-1", "MEM-2", "MEM-3", "RES-5"].sort()
    );
    expect(b.recipe).toBe("S03");
    expect(b.anchorCode).toBe("ISS-9");
    expect(b.calls.filter((c) => c.point === "P3")).toHaveLength(2);
  });
});
