/**
 * 那扇门上的**锚点来路**：显式钉住 / 按判断号定 / 检索。
 *
 * 这里要锁的是三件会静默出错的事：
 *
 * ① 给了判断号就**不许再去检索** —— 检索一次都命中不了（图里没有前端那些议题
 *    对象），多打一次 P3 只是白花一次往返，还会在 trace 上留下一条「没找到锚点」
 *    的假线索。
 * ② 判断号一条都不在图里 → `external_only`，而不是抛出去。那是分支不是故障。
 * ③ 图服务不可达 → 原样抛。折成 `external_only` 的后果是图服务一停机，每次运行
 *    都自动降级成纯外部，还照样产出一份格式完整的报告。
 */
import { describe, expect, it } from "vitest";

import type { GkDynamic, GkEntity, GraphKnowledgeClient } from "./client";
import { GraphKnowledgeNotFound, GraphKnowledgeUnavailable } from "./errors";
import { openContext } from "./index";

const TITLE = "入口移到交付侧之后，模型能力还是不是我们的护城河";

const ENTITIES: Record<string, GkEntity> = {
  "01-J3": {
    code: "01-J3",
    label: "溢价来自交付确定性",
    properties: { standing: "unverified" },
    relations: { belongsTo: ["D-01"] },
  },
  // 图内真实存在的那种议题（前端那十条不在图里）。只给显式钉锚点那一条用。
  "ISS-D7": {
    code: "ISS-D7",
    label: "入口是不是已经移到交付侧",
    properties: { state: "研讨中" },
  },
};

const CHAINS: Record<string, GkEntity> = {
  "01-J3": {
    code: "01-J3",
    versions: [{ index: 1, status: "active", at: "2026-07-02T00:00:00Z", statement: "溢价来自交付确定性。" }],
  },
};

function fake(opts: { absent?: string[]; down?: boolean; p0Down?: boolean } = {}) {
  const p3Calls: { q: string; k: number }[] = [];
  const absent = new Set(opts.absent ?? []);
  const guard = (code: string) => {
    if (opts.down) throw new GraphKnowledgeUnavailable(`不可达：${code}`);
    if (absent.has(code)) throw new GraphKnowledgeNotFound(`GraphKnowledge 锚点不存在: ${code}`);
  };
  const client = {
    baseUrl: "https://example.invalid/graph",
    viewer: "PSN-01",
    warnings: [],
    staticContext: async () => {
      if (opts.p0Down) throw new GraphKnowledgeUnavailable("不可达：/api/v1/context/static");
      return "毛利率 41%。";
    },
    entity: async (code: string) => {
      guard(code);
      return ENTITIES[code] ?? { code };
    },
    chain: async (code: string) => {
      guard(code);
      return CHAINS[code] ?? { code };
    },
    dynamic: async (q: string, o: { k: number; budget: number }): Promise<GkDynamic> => {
      p3Calls.push({ q, k: o.k });
      return { query: q, seeds: [{ code: "MEM-1", type: "Document", score: 0.6 }], text: "语义正文。" };
    },
  } as unknown as GraphKnowledgeClient;
  return { client, p3Calls };
}

const open = (client: GraphKnowledgeClient, judgmentCodes: string[]) =>
  openContext({
    recipe: "S02",
    prefix: "ISS-",
    channel: "A3",
    q: TITLE,
    judgmentCodes,
    client,
    asOf: "2026-08-19",
  });

/** 深研那一档。前缀与频道按 A4 填，`q` 是 core question（生产上就是议题标题）。 */
const openS03 = (
  client: GraphKnowledgeClient,
  judgmentCodes: string[],
  anchorCode?: string
) =>
  openContext({
    recipe: "S03",
    prefix: "ISS-",
    channel: "A4",
    q: TITLE,
    judgmentCodes,
    ...(anchorCode ? { anchorCode } : {}),
    client,
    asOf: "2026-08-19",
  });

describe("openContext · 按判断号定锚点", () => {
  it("给了判断号就不检索：P3 只打装配那一次，锚点来路记成 judgmentRefs", async () => {
    const { client, p3Calls } = fake();
    const opened = await open(client, ["01-J3"]);

    expect(opened.mode).toBe("anchored");
    expect(opened.anchorOrigin).toBe("judgmentRefs");
    // 检索那条路会先打一次 P3 找 ISS-* 候选。只有一次调用 = 那条路没走。
    expect(p3Calls).toHaveLength(1);
    expect(opened.bundle!.anchorCode).toBe("01-J3");
    expect(opened.trace.some((n) => n.detail.origin === "judgmentRefs")).toBe(true);
  });

  it("判断号一条都不在图里：转纯外部，原因写明白，**不抛**", async () => {
    const { client } = fake({ absent: ["01-J3"] });
    const opened = await open(client, ["01-J3"]);

    expect(opened.mode).toBe("external_only");
    expect(opened.bundle).toBeNull();
    expect(opened.anchorOrigin).toBeNull();
    expect(opened.noAnchorReason).toContain("01-J3");
  });

  it("图服务不可达：原样抛，不许折成纯外部", async () => {
    const { client } = fake({ down: true });
    await expect(open(client, ["01-J3"])).rejects.toBeInstanceOf(GraphKnowledgeUnavailable);
  });

  /*
   * 【公司经营状态】（P0）跟锚点无关，所以锚点没命中也要装上。
   *
   * 这三条一起锁的是「装上了，但没有因此谎报锚定」：多出一段真材料，代价不能是台账
   * 上凭空出现一个锚点。
   */
  it("锚点没命中也装上【公司经营状态】，但 mode 仍然是 external_only", async () => {
    const { client } = fake({ absent: ["01-J3"] });
    const opened = await open(client, ["01-J3"]);

    expect(opened.staticContext).toBe("毛利率 41%。");
    // 升成 anchored 就等于在台账上宣称有一个并不存在的锚点。
    expect(opened.mode).toBe("external_only");
    expect(opened.bundle).toBeNull();
    expect(opened.anchor).toBeNull();
    expect(opened.anchorOrigin).toBeNull();
  });

  it("P0 也取不到：空串 + warnings 记一条，**不把这一次运行判失败**", async () => {
    // 跟锚定那条路故意不一样：那条路上 P0 是正文的一部分，这条路上它是外加的一段。
    // 为它把一次本来能跑完的运行变成失败，换不来任何诚实 —— 空串时屏幕上写的就是
    // 原来那句「本次无公司上下文」，而 warnings 记着这次是因为取不到才没有。
    //
    // 走检索那条路（判断号为空）才到得了这里：按判断号那条路上装配自己会先打 P0
    // （`Builder.p0()` 是第一步），P0 挂了在那儿就抛出去了，压根走不到转纯外部。
    const { client } = fake({ p0Down: true });
    const opened = await open(client, []);

    expect(opened.mode).toBe("external_only");
    expect(opened.staticContext).toBe("");
    expect(opened.warnings.some((w) => w.includes("公司经营状态"))).toBe(true);
  });

  it("锚上了的时候 staticContext 是空串 —— P0 已经在 bundle 正文里，两处放会各自漂移", async () => {
    const { client } = fake();
    const opened = await open(client, ["01-J3"]);

    expect(opened.mode).toBe("anchored");
    expect(opened.staticContext).toBe("");
    expect(opened.bundle!.renderedMarkdown).toContain("毛利率 41%。");
  });

  it("判断号是空的（有议题确实不动摇任何在版判断）：照旧走检索", async () => {
    const { client, p3Calls } = fake();
    // 图里没有 ISS-* 候选，所以这一次会走成纯外部 —— 要验的是它**去检索了**。
    const opened = await open(client, []);

    expect(p3Calls).toHaveLength(1);
    expect(opened.mode).toBe("external_only");
    expect(opened.noAnchorReason).toContain("ISS-");
  });
});

/*
 * 深研那一档。同样的四种走向要在 S03 上再锁一遍 —— 这两档共用的只有「谁优先」那几行，
 * 装配函数是两个，而「S02 走对了」推不出「S03 也走对了」。
 *
 * 深研这条路上走错的代价还更大一档：它是要写进报告、再由 A10 拿去改本体的那一条。
 */
describe("openContext · 深研按判断号定锚点", () => {
  it("S03 给了判断号也不检索：装的是深研那份配方（两路 P3），来路记成 judgmentRefs", async () => {
    const { client, p3Calls } = fake();
    const opened = await openS03(client, ["01-J3"]);

    expect(opened.mode).toBe("anchored");
    expect(opened.anchorOrigin).toBe("judgmentRefs");
    expect(opened.bundle!.recipe).toBe("S03");
    expect(opened.bundle!.anchorCode).toBe("01-J3");
    // 两次 = 深研配方自己的双路。多出第三次就说明它又去检索锚点了。
    expect(p3Calls.map((c) => c.k)).toEqual([10, 5]);
    // 台账上要分得出这一轮走的是哪一档 —— 两档装回来的东西不一样厚。
    expect(
      opened.trace.some((n) => n.detail.origin === "judgmentRefs" && n.detail.recipe === "S03")
    ).toBe(true);
  });

  it("S03 的判断号一条都不在图里：转纯外部，**不抛** —— 那是分支不是故障", async () => {
    const { client } = fake({ absent: ["01-J3"] });
    const opened = await openS03(client, ["01-J3"]);

    expect(opened.mode).toBe("external_only");
    expect(opened.bundle).toBeNull();
    expect(opened.anchorOrigin).toBeNull();
    expect(opened.noAnchorReason).toContain("01-J3");
    // 锚点没命中也照样装上【公司经营状态】：那一段跟锚点没有关系。
    expect(opened.staticContext).toBe("毛利率 41%。");
  });

  it("S03 的判断号有、图服务不可达：原样抛，不许折成纯外部", async () => {
    // 折成纯外部的后果是图服务一停机，每一轮深研都自动降级，还照样产出一份格式完整的
    // 报告 —— 而那份报告里「公司现有判断」那几段是空的，没有一处会报错。
    const { client } = fake({ down: true });
    await expect(openS03(client, ["01-J3"])).rejects.toBeInstanceOf(GraphKnowledgeUnavailable);
  });

  it("S03 判断号为空：回落到检索，不许自己造一个锚点出来", async () => {
    const { client, p3Calls } = fake();
    const opened = await openS03(client, []);

    // 一次 = 检索锚点那次。图里没有 ISS-* 候选，所以这一轮走成纯外部。
    expect(p3Calls).toHaveLength(1);
    expect(opened.mode).toBe("external_only");
    expect(opened.noAnchorReason).toContain("ISS-");
  });

  it("S03 显式钉了 anchorCode：压过判断号，装的是按议题那一档", async () => {
    // 复现旧运行靠这条路。判断号压过它的话，同一个 anchorCode 两次跑出来的上下文不一样，
    // 而复现的全部意义就是它们一样。
    const { client } = fake();
    const opened = await openS03(client, ["01-J3"], "ISS-D7");

    expect(opened.anchorOrigin).toBe("explicit");
    expect(opened.bundle!.anchorCode).toBe("ISS-D7");
    // 按议题那一档才有【议题】那一行带编号；按判断那一档写的是「图谱里还没有对应的议题对象」。
    expect(opened.bundle!.renderedMarkdown).toContain("ISS-D7「入口是不是已经移到交付侧」");
    expect(opened.bundle!.renderedMarkdown).not.toContain("图谱里还没有对应的议题对象");
  });
});
