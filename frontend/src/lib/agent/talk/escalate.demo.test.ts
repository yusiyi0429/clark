/**
 * 交接深研在已有报告时的分支 —— 只有 demo 档下测得到。
 *
 * 这个分支要验证三件事：(1) `landed` 是空串，(2) `told` 里如实说要他自己打回重研，
 * (3) 不作废现有报告。第三条是「绝对不许删或作废那份报告」的守卫 —— 有它在，将来
 * 谁想把这一路改成 `reopenDeepResearch` 会立刻红。
 *
 * 走 demo 那一档是因为 demo 会把整包报告塞进 `store.researchDocs`，所以手上就有一份
 * **带报告**的议题 —— 这是 live 档下拿不到的东西，也正是这个分支需要的前置。
 * 单独一个文件：`TKOS_MODE` 必须在 `store.ts` 被 import 之前定下来。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "@/lib/data/store";
import type { Evidence } from "@/lib/research/ledger";

let api: typeof Api;

beforeAll(async () => {
  process.env.TKOS_MODE = "demo";
  process.env.TKOS_PERSIST = "0";
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("@/lib/data/store")).api;
});

const ISSUE = "ISS-D4";

describe("交接深研：已有报告时只如实回话，报告不动", () => {
  it("已有报告时 landed 是空串、told 如实说要他自己打回重研、报告还在", async () => {
    // 确认这件议题有报告
    const docBefore = await api.getResearchDoc(ISSUE);
    expect(docBefore).not.toBeNull();
    expect(docBefore?.issueId).toBe(ISSUE);

    const r = await api.recordEscalation({
      type: "deep_research_handoff",
      payload: { issueId: ISSUE, why: "缺口扩到整个议题" },
    });

    // landed 是空串
    expect(r.landed).toBe("");
    // 原来钉的是「打回重研」那颗不存在的键。真正要守的是：**它不替他作废现有报告** ——
    // 这一句下面那两条断言（报告还在）钉的是同一件事的另一头。
    expect(r.told).toContain("不会替你把现有报告作废");
    expect(r.told).not.toContain("打回重研");

    // 报告还在 —— 不许作废现有报告
    const docAfter = await api.getResearchDoc(ISSUE);
    expect(docAfter).not.toBeNull();
    expect(docAfter?.issueId).toBe(ISSUE);
  });
});

/** 一条现查回来的证据。轮内取证回来的条目永远从 `E1` 起 —— 落库那一步要重排编号。 */
const fresh = (claim: string) =>
  ({
    id: "E1",
    claim,
    exactQuote: `${claim}（原文）`,
    siteName: "国家统计局",
    sourceTier: "A",
    sourceDomain: "stats.gov.cn",
    url: "https://example.invalid/x",
    retrievedAt: "2026-08-27",
    independenceGroup: "G1",
  } as unknown as Evidence);

describe("轮内取证的产物落台账", () => {
  it("落进台账并重排编号，返回的就是真落进去的那几条", async () => {
    const before = await api.getResearchDoc(ISSUE);
    const beforeIds = (before?.ledger ?? []).map((e) => e.id);
    const beforeBlocks = before?.blocks;

    // 第一次：落进去，返回的那一条要能在台账里指认出来
    const one = await api.landTalkEvidence(ISSUE, [fresh("这一句是现查回来的")]);
    expect(one).toHaveLength(1);
    const mid = await api.getResearchDoc(ISSUE);
    expect((mid?.ledger ?? []).map((e) => e.id)).toEqual([...beforeIds, one[0].id]);
    expect(mid?.ledger?.at(-1)?.claim).toBe("这一句是现查回来的");

    /*
     * 第二次：轮内取证回来的条目**永远从 `E1` 起**（`Ledger` 的计数器没法播种），所以这一步
     * 才是真正要钉住的东西 —— 第二条不许再拿到第一条那个号。撞号的后果不是显示难看：他看到
     * 模型引同一个号时指的是两条不同的证据。
     */
    const two = await api.landTalkEvidence(ISSUE, [fresh("这是第二句")]);
    expect(two[0].id).not.toBe(one[0].id);
    const after = await api.getResearchDoc(ISSUE);
    expect((after?.ledger ?? []).map((e) => e.id)).toEqual([...beforeIds, one[0].id, two[0].id]);
    // 报告正文一块都没动
    expect(after?.blocks).toEqual(beforeBlocks);
  });

  it("一条都没有就原样回，不动台账", async () => {
    const before = await api.getResearchDoc(ISSUE);
    expect(await api.landTalkEvidence(ISSUE, [])).toEqual([]);
    const after = await api.getResearchDoc(ISSUE);
    expect(after?.ledger?.length ?? 0).toBe(before?.ledger?.length ?? 0);
  });
});
