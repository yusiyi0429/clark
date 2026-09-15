/**
 * **检索家通不通的一次性真跑。默认整条跳过 —— 它会真的打接口。**
 *
 * 打开：`TKOS_SEARCH_LIVE=1`。一条问法、每家几条，代价可以忽略。
 *
 * ## 它验的不是「接口活着」，是「这台机器上这几家真的会被用上」
 *
 * 所以走的是 `providers()` 和 `searchAll` **本身**，不是自己另写一段 fetch：深研那条链
 * 用的就是这两个函数，自己再写一段的话，验过的是一段谁都不跑的代码。
 *
 * 两件事分开看，因为它们的处置完全不同：
 *  · 某一家**没进阵容** —— 配置问题（家名写错、key 没配）。`skipped` 里有原话。
 *  · 某一家进了阵容但**一条都没返回** —— 接口问题（key 失效、欠费、限流）。`errors` 里有原话。
 *
 * 这两种在报告上都表现成「这一轮外面的材料比预期少」，分不开的话查不下去。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { providers, searchAll, providerLabel } from "./search";

const ON = process.env.TKOS_SEARCH_LIVE === "1";
const run = ON ? it : it.skip;

/** `.env.local` 抄进来。同 `qwen-research.live.test.ts`，理由也是同一个：vitest 不读它。 */
function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
    const line = raw.replace("\r", "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

beforeAll(() => {
  if (!ON) return;
  loadEnvLocal();
  // 这个开关的含义是「不出网」，会把阵容整个换成假检索 —— 那正是这条用例要避开的。
  delete process.env.TKOS_MODEL_MOCK;
});

describe("配着的每一家都真的搜得回东西", () => {
  run(
    "阵容里每一家 returned 都 > 0",
    async () => {
      const setup = providers();
      const names = setup.list.map((p) => p.name);

      console.log(
        `\n阵容：${providerLabel(setup.list)}（${names.join(" + ")}）` +
          (setup.skipped.length ? `\n用不上的：${setup.skipped.join("；")}` : "")
      );

      expect(names, "一家都没进阵容 —— 看 TKOS_SEARCH_PROVIDER 和那几把 key").not.toEqual(["none"]);
      expect(setup.skipped, "有家名配了却用不上").toEqual([]);

      const { hits, errors, perProvider } = await searchAll(
        setup.list,
        ["锂电池隔膜 2026 年 产能 扩产"],
        5
      );

      console.log(
        [
          `总命中 ${hits.length}`,
          ...Object.entries(perProvider).map(
            ([n, a]) => `  ${n}：返回 ${a.returned}、独有 ${a.unique}`
          ),
          errors.length ? `报错：${errors.join("；")}` : "无报错",
          "",
        ].join("\n")
      );

      expect(errors, "有家报错了").toEqual([]);
      for (const n of names) {
        expect(perProvider[n]?.returned ?? 0, `${n} 一条都没返回`).toBeGreaterThan(0);
      }
    },
    120_000
  );
});
