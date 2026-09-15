/**
 * `buildS02FromJudgments` —— 锚点是判断而不是议题的那一档。
 *
 * 为什么单独给它一个文件：这条路上每一件事错了都**不会报错**。少渲染一段版本链，
 * 模型看不到判断的演进史；把 404 的判断号当成取到了，台账上「以它为锚点」是假的；
 * 缺的那几条不写进正文，模型会把「图里只有这两条」读成「这个议题只动摇这两条」；
 * 一条都不在图里却照样返回一份 bundle，那就是把纯外部伪装成有公司依据。
 *
 * 客户端打成固定返回：这里要验的是**装配逻辑**，不是图服务。
 */
import { describe, expect, it } from "vitest";

import type { GkDynamic, GkEntity, GraphKnowledgeClient } from "./client";
import { AnchorNotFound, GraphKnowledgeNotFound, GraphKnowledgeUnavailable } from "./errors";
import { buildS02FromJudgments } from "./recipes";

const TITLE = "入口移到交付侧之后，模型能力还是不是我们的护城河";

const ENTITIES: Record<string, GkEntity> = {
  "01-J3": {
    code: "01-J3",
    label: "溢价来自交付确定性",
    properties: { standing: "unverified" },
    relations: { belongsTo: ["D-01"] },
  },
  "01-J11": {
    code: "01-J11",
    label: "行业线先只做金融",
    properties: { standing: "shaking" },
    relations: { belongsTo: ["D-01"], shakenBy: ["ISS-D7"], researchForOf: ["RES-5"] },
  },
  "RES-5": {
    code: "RES-5",
    label: "交付侧入口调研",
    properties: { text: "六家客户里五家的入口已经在交付团队。" },
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

const P3: GkDynamic = {
  query: TITLE,
  seeds: [{ code: "MEM-1", type: "Document", score: 0.62 }],
  text: "语义正文。",
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
      return P3;
    },
  } as unknown as GraphKnowledgeClient;
  return { client, p3Calls };
}

const build = (client: GraphKnowledgeClient, codes: string[]) =>
  buildS02FromJudgments(client, codes, { query: TITLE, viewer: "PSN-01", asOf: "2026-08-19" });

describe("buildS02FromJudgments", () => {
  it("装的是判断的版本链、所属域与相邻动摇；P3 参数与 buildS02 一样固定在 (3, 1200)", async () => {
    const { client, p3Calls } = fake();
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(b.renderedMarkdown).toContain("【公司经营状态】");
    expect(b.renderedMarkdown).toContain("01-J3「溢价来自交付确定性」（unverified）");
    // 全部版本，不只最新版：少了演进史，模型不知道这句话是怎么变成现在这样的。
    expect(b.renderedMarkdown).toContain("v1[superseded] 2026-03-04");
    expect(b.renderedMarkdown).toContain("v2[active] 2026-07-02（7 月战略会）");
    expect(b.renderedMarkdown).toContain("  所属：D-01");
    expect(b.renderedMarkdown).toContain("  相邻动摇：ISS-D7");
    expect(b.renderedMarkdown).toContain("六家客户里五家的入口已经在交付团队。");
    expect(p3Calls).toEqual([{ q: TITLE, k: 3, budget: 1200 }]);
    expect(b.recipe).toBe("S02");
    expect(b.anchorCode).toBe("01-J3+01-J11");
    expect(b.memberIds).toEqual(["01-J11", "01-J3", "D-01", "ISS-D7", "MEM-1", "RES-5"].sort());
  });

  it("不写【议题定义】，并且明写图谱里没有这条议题对象 —— 否则模型会当公司已经研究过它", async () => {
    const { client } = fake();
    const b = await build(client, ["01-J3"]);

    expect(b.renderedMarkdown).not.toContain("【议题定义】");
    expect(b.renderedMarkdown).toContain(TITLE);
    expect(b.renderedMarkdown).toContain("图谱里还没有对应的议题对象");
  });

  it("一条判断号 404：正文写出少了哪条，warnings 也记一条，锚点只写真取到的", async () => {
    const { client } = fake({ absent: ["01-J11"] });
    const b = await build(client, ["01-J3", "01-J11"]);

    expect(b.renderedMarkdown).toContain("【图谱里查不到的判断】");
    expect(b.renderedMarkdown).toContain("01-J11");
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
