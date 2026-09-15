process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";

import { Harness } from "@/lib/agent/harness";
import type { Evidence } from "@/lib/research/ledger";

import { answerFromCheck, buildCheckUser, notFoundReply, offLedger } from "./check";

/**
 * 「查一下」的作答那一半。
 *
 * 取证与落台账两步不在这里测（`micro.test.ts` 与 `store.quick-check.test.ts` 各管一头）
 * —— 这个文件只管一件事：**这段话里的编号指得到手上那几条**。
 */

/** 一条现查回来的证据。带口径四件套 —— 「口径：」那一行要印得出来。 */
const ev = (id: string, claim: string): Evidence =>
  ({
    id,
    claim,
    exactQuote: `${claim}（原文）`,
    siteName: "国家统计局",
    sourceTier: "A",
    sourceDomain: "stats.gov.cn",
    url: `https://example.invalid/${id}`,
    retrievedAt: "2026-08-29",
    independenceGroup: "G1",
    value: 48,
    unit: "%",
    period: "2025Q2",
  }) as unknown as Evidence;

let h: Harness;
beforeAll(() => {
  h = new Harness({ agent: "A4", slot: "pro" });
});

describe("查一下：喂给作答那一次的形状", () => {
  it("每一条都带原文引句与口径 —— 与按编号查回来那一路同一份", () => {
    const user = buildCheckUser("2025Q2 同口径份额", [ev("E7", "份额 48%")]);
    expect(user).toContain("2025Q2 同口径份额");
    expect(user).toContain("E7｜份额 48%");
    expect(user).toContain("原文：");
    /*
     * 口径那一行是这一层反复强调的东西（`TALK_SYSTEM` 第 7 条）。上一版轮内取证那一支
     * 自己内联拼过一份，整条「口径」行就那么没了 —— 所以三条取证路必须共用
     * `describeFound`。变异验证：把 `buildCheckUser` 改成自己拼 `${id}｜${claim}` → 这一条红。
     */
    expect(user).toContain("口径：48%，2025Q2");
  });
});

describe("查一下：编号只许从手上那几条里取", () => {
  it("引到的号都在手上那几条里", async () => {
    const entries = [ev("E11", "份额 48%"), ev("E12", "同口径下上一季是 45%")];
    const r = await answerFromCheck(h, "2025Q2 同口径份额", entries);
    expect(r.cited.length).toBeGreaterThan(0);
    expect(r.fabricated).toEqual([]);
    for (const id of r.cited) expect(entries.map((e) => e.id)).toContain(id);
  });

  it("引了台账里没有的号要数得出来 —— 但正文一个字都不改", () => {
    const entries = [ev("E11", "份额 48%")];
    /*
     * 这一条钉的是「编造的引用被看见」。变异验证：把 `offLedger` 改成 `return []`
     * → 这一条红；而那正是「一段读起来完全有据可查、点开却指不到任何东西的话」
     * 悄悄上屏的那条路。
     */
    expect(offLedger("这个说法成立[E11]，另外还有一条[E99]。", entries)).toEqual(["E99"]);
    // 一次引两个的写法要拆开数（`citedIds` 的口径），漏拆等于放行一半编造的号
    expect(offLedger("两条都指向同一件事[E11, E98]。", entries)).toEqual(["E98"]);
    expect(offLedger("这个说法成立[E11]。", entries)).toEqual([]);
  });
});

describe("查一下：查不到是合法结果", () => {
  it("一条证据都没有时不发那次调用，照实回一句", async () => {
    const before = h.finish({ status: "ok" }).trace.length;
    const r = await answerFromCheck(h, "查不到的东西", []);
    expect(r.reply).toContain("这一轮没查到能引的材料");
    expect(r.cited).toEqual([]);
    /*
     * 没有证据还去发一次「带编号作答」，拿回来的只会是编造的编号。
     * 变异验证：把 `answerFromCheck` 开头那道 `entries.length === 0` 去掉 → trace 上
     * 多一条模型调用，这一条红。
     */
    expect(h.finish({ status: "ok" }).trace.length).toBe(before);
  });

  it("那句话里说得出发过哪几个问法，且不替他拿主意", () => {
    const r = notFoundReply(["2025Q2 份额", "2025Q2 份额 反例"]);
    expect(r.reply).toContain("「2025Q2 份额」");
    expect(r.reply).toContain("「2025Q2 份额 反例」");
    // 上屏那句话只报事实。指示性的话（「建议」「不妨」「可以试试」）一个都不许有。
    for (const word of ["建议", "不妨", "可以试试", "要不要"]) {
      expect(r.reply).not.toContain(word);
    }
  });
});
