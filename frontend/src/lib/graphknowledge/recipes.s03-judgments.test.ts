/**
 * `buildS03FromJudgments` —— 深研那一档，锚点是判断而不是议题。
 *
 * 为什么单独给它一个文件：跟按判断定锚点的预研那一档一样，这条路上每一件事错了都
 * **不会报错**。少渲染一段版本链，模型看不到判断的演进史；共识段不写来路，模型会把
 * 别的议题定下的边界读成「这件事公司已经定过了」；第二路 P3 发错东西，双路合并退化成
 * 单路而屏幕上照样写着「双路合并」；一条判断都不在图里却照样返回一份 bundle，那就是把
 * 纯外部伪装成有公司依据。
 *
 * 客户端打成固定返回：这里要验的是**装配逻辑**，不是图服务。
 */
import { describe, expect, it } from "vitest";

import type { GkDynamic, GkEntity, GraphKnowledgeClient } from "./client";
import { AnchorNotFound, GraphKnowledgeNotFound, GraphKnowledgeUnavailable } from "./errors";
import { buildS03FromJudgments } from "./recipes";

const CORE = "入口移到交付侧之后，模型能力还是不是我们的护城河";

const ENTITIES: Record<string, GkEntity> = {
  "01-J3": {
    code: "01-J3",
    label: "溢价来自交付确定性",
    properties: { standing: "unverified" },
    relations: { belongsTo: ["D-01"], shakenBy: ["ISS-D7"], researchForOf: ["RES-5"] },
  },
  "01-J11": {
    code: "01-J11",
    label: "行业线先只做金融",
    properties: { standing: "shaking" },
    relations: { belongsTo: ["D-01"], shakenBy: ["ISS-D7"] },
  },
  /** 一条什么都没挂的判断。共识那一跳走不出去时用它。 */
  "01-J9": { code: "01-J9", label: "自建交付团队", properties: { standing: "active" } },
  /** 图内**真实存在**的那种议题（前端那十条不在图里）。共识就挂在它身上。 */
  "ISS-D7": {
    code: "ISS-D7",
    label: "入口是不是已经移到交付侧",
    properties: { state: "研讨中" },
    relations: { resolvedBy: ["AGR-2"], researchForOf: ["RES-9"] },
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
  "RES-9": {
    code: "RES-9",
    label: "金融行业线复盘",
    properties: { text: "金融线毛利率 43%，比公司均值高两个点。" },
  },
};

const CHAINS: Record<string, GkEntity> = {
  "01-J3": {
    code: "01-J3",
    versions: [
      { index: 1, status: "superseded", at: "2026-03-04T00:00:00Z", statement: "能力差异足以支撑溢价。" },
      {
        index: 2,
        status: "active",
        at: "2026-07-02T00:00:00Z",
        statement: "溢价来自交付确定性，能力差异只是入场券。",
        meetingLabel: "7 月战略会",
      },
    ],
  },
  "01-J11": {
    code: "01-J11",
    versions: [{ index: 1, status: "active", at: "2026-06-01T00:00:00Z", statement: "先在金融一个行业做深。" }],
  },
};

/** 两路 P3 按 k 分派 —— k 就是这两路的身份证（10 = core question，5 = 锚点判断标签）。 */
const P3: Record<number, GkDynamic> = {
  10: {
    query: CORE,
    seeds: [{ code: "MEM-1", type: "Judgement", score: 0.81 }],
    text: "core question 路的语义正文。",
  },
  5: {
    query: "溢价来自交付确定性、行业线先只做金融",
    seeds: [{ code: "MEM-2", type: "Agreement", score: 0.77 }],
    text: "锚点判断标签路的语义正文。",
  },
};

/** `absent` 里的编号返回 404；`down` 时整个客户端不可达。 */
function fake(opts: { absent?: string[]; down?: boolean } = {}) {
  const p3Calls: { q: string; k: number; budget: number }[] = [];
  const absent = new Set(opts.absent ?? []);
  const guard = (code: string) => {
    if (opts.down) throw new GraphKnowledgeUnavailable(`不可达：${code}`);
    if (absent.has(code)) throw new GraphKnowledgeNotFound(`GraphKnowledge 锚点不存在: ${code}`);
  };
  const client = {
    baseUrl: "https://example.invalid/graph",
    staticContext: async () => "毛利率 41%，现金覆盖 9 个月。",
    entity: async (code: string) => {
      guard(code);
      return ENTITIES[code] ?? { code };
    },
    chain: async (code: string) => {
      guard(code);
      return CHAINS[code] ?? { code };
    },
    dynamic: async (q: string, o: { k: number; budget: number }) => {
      p3Calls.push({ q, k: o.k, budget: o.budget });
      return P3[o.k] ?? { query: q, seeds: [], warning: "no_route" };
    },
  } as unknown as GraphKnowledgeClient;
  return { client, p3Calls };
}

const build = (client: GraphKnowledgeClient, codes: string[]) =>
  buildS03FromJudgments(client, codes, { coreQuestion: CORE, viewer: "PSN-01", asOf: "2026-08-19" });

describe("buildS03FromJudgments", () => {
  it("演进链渲染全部版本，不只是最新版 —— 少了演进史，深研做不成取舍", async () => {
    const { client } = fake();
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(b.renderedMarkdown).toContain("01-J3「溢价来自交付确定性」（unverified）");
    expect(b.renderedMarkdown).toContain("v1[superseded] 2026-03-04");
    expect(b.renderedMarkdown).toContain("v2[active] 2026-07-02（7 月战略会）");
    expect(b.renderedMarkdown).toContain("  所属：D-01");
    expect(b.renderedMarkdown).toContain("  相邻动摇：ISS-D7");
    expect(b.recipe).toBe("S03");
    expect(b.anchorCode).toBe("01-J3+01-J11");
  });

  it("不写【议题定义】，并且明写图谱里没有这条议题对象 —— 否则模型会当公司已经研究过它", async () => {
    const { client } = fake();
    const b = await build(client, ["01-J3"]);

    expect(b.renderedMarkdown).not.toContain("【议题定义】");
    expect(b.renderedMarkdown).toContain(CORE);
    expect(b.renderedMarkdown).toContain("图谱里还没有对应的议题对象");
  });

  it("共识从相邻动摇的图内议题走一跳取，标题里写明来路 —— 不写就成了「这件事公司定过了」", async () => {
    const { client } = fake();
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(b.renderedMarkdown).toContain("【既有共识与边界 · 来自图内正动摇同一条判断的议题】");
    expect(b.renderedMarkdown).toContain("AGR-2「行业线先只做金融」status=active");
    // 边界少了，一条有条件的共识会被读成无条件成立。
    expect(b.renderedMarkdown).toContain("边界：只在 2026 年内成立");
    // 两条判断动摇的是同一条议题，共识只该出现一次。
    expect(b.renderedMarkdown.split("AGR-2「").length - 1).toBe(1);
  });

  it("既有研究把判断自己挂的和相邻议题挂的合起来，同一条不重复", async () => {
    const { client } = fake();
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(b.renderedMarkdown).toContain("六家客户里五家的入口已经在交付团队。");
    expect(b.renderedMarkdown).toContain("金融线毛利率 43%，比公司均值高两个点。");
    expect(b.renderedMarkdown.split("RES-9「").length - 1).toBe(1);
  });

  it("一跳走不出去时不写「议题未闭环」—— 这一档没有议题对象，答不出它闭没闭环", async () => {
    const { client } = fake();
    const b = await build(client, ["01-J9"]);

    expect(b.renderedMarkdown).toContain("答不出这条议题自己闭没闭环");
    expect(b.renderedMarkdown).not.toContain("（议题未闭环）");
    expect(b.renderedMarkdown).toContain("（锚点 01-J9 无版本链——首次形成）");
  });

  it("两路 P3 的参数由配方固定 (10, 6000) / (5, 3000)，第二路发的是锚点判断的标签", async () => {
    // 换一条锚点路，语义段的厚度不该跟着变，否则两次深研不可比。第二路按议题那一档发的
    // 是议题标题，这一档没有议题对象，发标签 —— 发 core question 就等于两路同一句话。
    const { client, p3Calls } = fake();
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(p3Calls).toEqual([
      { q: CORE, k: 10, budget: 6000 },
      { q: "溢价来自交付确定性、行业线先只做金融", k: 5, budget: 3000 },
    ]);
    expect(b.renderedMarkdown).toContain("【语义召回 · 双路合并】");
    expect(b.renderedMarkdown).toContain("正文采用得分最高路由：core question");
  });

  it("memberIds 是这次摸到的全部实体：一跳带回来的议题、共识、研究都在", async () => {
    // 这份表是「引用 ID 真实」自检的白名单：漏一个，正确的引用会被判成编的。
    const { client } = fake();
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(b.memberIds).toEqual(
      ["01-J11", "01-J3", "AGR-2", "D-01", "ISS-D7", "MEM-1", "MEM-2", "RES-5", "RES-9"].sort()
    );
  });

  it("一条判断号 404：正文写出少了哪条，warnings 也记一条，锚点只写真取到的", async () => {
    const { client } = fake({ absent: ["01-J11"] });
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(b.renderedMarkdown).toContain("【图谱里查不到的判断】");
    expect(b.warnings).toContain("判断号图内查不到：01-J11");
    // 台账上的 contextAnchor 不许写一条压根没取到的编号。
    expect(b.anchorCode).toBe("01-J3");
  });

  it("一条都不在图里就抛 AnchorNotFound —— 那是分支，由那扇门转纯外部", async () => {
    const { client } = fake({ absent: ["01-J3", "01-J11"] });
    await expect(build(client, ["01-J3", "01-J11"])).rejects.toBeInstanceOf(AnchorNotFound);
  });

  it("图服务不可达原样抛出，**不折成「图里没有这条判断」** —— 折了就每次都悄悄降级", async () => {
    const { client } = fake({ down: true });
    await expect(build(client, ["01-J3"])).rejects.toBeInstanceOf(GraphKnowledgeUnavailable);
  });
});
