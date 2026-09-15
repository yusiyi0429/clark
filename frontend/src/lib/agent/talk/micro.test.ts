// src/lib/agent/talk/micro.test.ts
import { beforeAll, describe, expect, it } from "vitest";

import { Harness } from "@/lib/agent/harness";
import { providers, type SearchHit, type SearchProvider } from "@/lib/research/search";

import { capQueries, MICRO_LIMITS, runMicroResearch } from "./micro";

// 本任务**一个新罐头都不加**。组命题不发模型（下面 Step 3 是固定模板），gatherEvidence
// 里唯一那次模型调用是抽取，走既有的 a4.extract 罐头（src/lib/models/mock.ts:271）。
// 那个罐头的 exactQuote「示例数值为 1590 EFLOPS，统计截至 2025 年末」与 mockPage()
// （src/lib/research/fetch.ts:103，正文在 :111-114）逐字对得上，所以离线也能走通
// 「入账 → 折叠 → 覆盖判定」；谁改一边忘了另一边，这里会红成「一条都没入账」，
// 而不是在某次真运行里表现成「这题没搜到」。

/** 造一个假检索家。三个只给人看的字段照 SearchProvider 的形状填齐。 */
const provider = (name: string, fn: SearchProvider["search"]): SearchProvider => ({
  name, label: name, windowed: false, reason: "", search: fn,
});

/**
 * 一原稿多转载。**构造法的要害在 mockPage()**：它按**主机名里最后一个数字**挑署名机构
 * （`fetch.ts:110`，没有数字算 `"0"`），而 `independence.assign` 的第一优先就是正文署名
 * （`independence.ts:107-110`，同署名 → 同一个 `src:{机构}` 组）。所以五个**不带数字**的
 * 主机名会拿到同一个署名机构、被折成一组。
 *
 * （`a4/cosource.test.ts` 里没有可抄的构造法 —— 那个文件里只有 `{id, independenceGroup}`
 * 这种字面量，一个 SearchProvider 都没造。别去那儿找。）
 */
const cosourceList: SearchProvider[] = [
  provider("mirror", async (q, k) =>
    ["alpha", "beta", "gamma", "delta", "epsilon"].slice(0, Math.max(1, k)).map((host) => ({
      title: `（假材料）${q} — ${host}`,
      url: `https://${host}-mirror.example.org/p/${encodeURIComponent(q).slice(0, 12)}`,
      snippet: "转载。",
      sourceDomain: `${host}-mirror.example.org`,
    })) as SearchHit[]),
];

/** 一条都不回的假检索家 —— not_found 那条用它。 */
const emptyList: SearchProvider[] = [provider("empty", async () => [])];

/** 把发出去的检索式记下来，再转给真的那一家。 */
const counting = (calls: string[], inner: SearchProvider[]): SearchProvider[] =>
  inner.map((p) => provider(p.name, async (q, k, w) => { calls.push(q); return p.search(q, k, w); }));

let h: Harness;
beforeAll(() => {
  process.env.TKOS_MODEL_MOCK = "1";
  h = new Harness({ agent: "A4", slot: "pro" });
});

describe("micro_research", () => {
  it("查得到：证据带 E 编号、原文引句与共源分组，语义与深研那份一致", async () => {
    const r = await runMicroResearch(h, { search: providers().list }, { question: "2025Q2 同口径份额", issueId: "ISS-1" });
    expect(r.kind).toBe("found");
    // 不用 if 包 —— 上面那行已经把 kind 钉住了，断言不能躲进一个桩不会进的分支。
    const found = r as Extract<typeof r, { kind: "found" }>;
    expect(found.entries.length).toBeGreaterThan(0);
    expect(found.entries[0].exactQuote.length).toBeGreaterThan(0);
    expect(found.entries[0].independenceGroup).toBeTruthy();
  });

  it("一原稿四转载 → 独立来源算 1（共源判定与深研共用一套）", async () => {
    const r = await runMicroResearch(h, { search: cosourceList }, { question: "份额", issueId: "ISS-1" });
    expect(r.kind).toBe("found");
    expect((r as Extract<typeof r, { kind: "found" }>).independentGroups).toBe(1);
  });

  it("查不到就是 not_found，带查过什么 —— 不抛，不让这一轮失败", async () => {
    const r = await runMicroResearch(h, { search: emptyList }, { question: "查不到的东西", issueId: "ISS-1" });
    expect(r.kind).toBe("not_found");
    const nf = r as Extract<typeof r, { kind: "not_found" }>;
    expect(nf.tried.length).toBeGreaterThan(0);
    expect(nf.why.length).toBeGreaterThan(0);
  });

  it("查询条数不超上限", async () => {
    const calls: string[] = [];
    await runMicroResearch(h, { search: counting(calls, providers().list) }, { question: "x", issueId: "ISS-1" });
    expect(calls.length).toBeGreaterThan(0);         // 一条都没发也会「不超上限」
    expect(calls.length).toBeLessThanOrEqual(MICRO_LIMITS.maxQueries);
  });
});

describe("capQueries", () => {
  it("两栏都不超上限时原样保留", () => {
    const r = capQueries(["a"], ["b"], 5);
    expect(r.queries).toEqual(["a"]);
    expect(r.counterQueries).toEqual(["b"]);
  });

  it("正问超上限时先砍正问、保证反证至少一条", () => {
    const r = capQueries(["a", "b", "c", "d", "e", "f"], ["x", "y"], 5);
    expect(r.queries).toEqual(["a", "b", "c", "d"]);
    expect(r.counterQueries).toEqual(["x"]);
  });

  it("反证超上限时截断反证", () => {
    const r = capQueries(["a", "b", "c"], ["x", "y", "z"], 5);
    expect(r.queries).toEqual(["a", "b", "c"]);
    expect(r.counterQueries).toEqual(["x", "y"]);
  });

  it("反证栏本来就是空的时保持为空", () => {
    const r = capQueries(["a"], [], 5);
    expect(r.queries).toEqual(["a"]);
    expect(r.counterQueries).toEqual([]);
  });
});
