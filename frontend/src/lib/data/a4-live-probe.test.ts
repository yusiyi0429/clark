/**
 * **验收用的一次性真跑。默认整条跳过 —— 它会真的调模型、真的花钱。**
 *
 * 打开：`TKOS_A4_LIVE=1` 加上 `TKOS_COST_TAP=<文件>`。
 *
 * 它验的是一件事：**N3 分维度取证真的跑起来了。** 罐头那条路验不到 ——
 * `mock.ts` 交回来的是一个形状完美的整对象，而这一次要修的正是「真模型交回来的东西被
 * 截断之后还能不能用」。所以只有真跑一轮才算数。
 *
 * 判据不看报告写得好不好，看两个数：这一轮有没有发出去检索请求、有没有逐页抽取。
 * 两个都是 0 就是那个 bug 还在（`pipeline.ts` 的 `!props.length` 那一支）。
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { api as Api } from "./store";

const ON = process.env.TKOS_A4_LIVE === "1" && Boolean(process.env.TKOS_COST_TAP);
const run = ON ? it : it.skip;
const LONG = 30 * 60 * 1000;

let api: typeof Api;

const loadEnvLocal = async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(".env.local")) return;
  for (const raw of readFileSync(".env.local", "utf8").split(String.fromCharCode(10))) {
    const line = raw.replace(String.fromCharCode(13), "").trim();
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
};

beforeAll(async () => {
  if (!ON) return;
  await loadEnvLocal();
  process.env.TKOS_PERSIST = "0";
  delete process.env.TKOS_MODEL_MOCK;
  api = (await import("./store")).api;
});

describe("真跑一轮深研", () => {
  run(
    "N3 取证跑起来了：发出去了检索，也逐页抽取了",
    async () => {
      process.env.TKOS_COST_STAGE = "A3-预研";
      const issue = await api.addIssue(
        "首批客户按行业挑，还是按「一号位是否真正牵引」挑？两条路对销售和交付的要求不一样。",
      );
      for (let i = 0; i < 400; i += 1) {
        const st = await api.preResearchStatus(issue.id);
        if (st.status === "done" || st.status === "failed") break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      const card = (await api.listPending()).find((c) => c.issueId === issue.id);
      if (!card) throw new Error("没落出卡来");

      process.env.TKOS_COST_STAGE = "A4-深研";
      await api.disposeCard(card.id, "discuss");
      for (let i = 0; i < 1200; i += 1) {
        const st = await api.deepResearchStatus(issue.id);
        if (st.status === "done" || st.status === "failed") break;
        await new Promise((r) => setTimeout(r, 1500));
      }

      const { readFileSync } = await import("node:fs");
      const rows = readFileSync(process.env.TKOS_COST_TAP!, "utf8")
        .split(String.fromCharCode(10))
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((r) => String(r.stage).startsWith("A4"));

      const searches = rows.filter((r) => r.kind === "search").length;
      const extracts = rows.filter((r) => r.hint === "a4.extract").length;
      console.log(`[A4 真跑] 检索 ${searches} 次，逐页抽取 ${extracts} 次`);

      expect(searches).toBeGreaterThan(0);
      expect(extracts).toBeGreaterThan(0);
    },
    LONG,
  );
});
