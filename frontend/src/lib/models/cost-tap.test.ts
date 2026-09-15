/**
 * 量钱那个口的两条硬规矩。
 *
 * 两条都属于「坏了没有症状」那一类，所以值得单独钉：
 *
 * 1. **关着的时候一个字节都不写。** 它挂在三条真实链路上（模型调用、检索、对谈流），
 *    默认状态下不许有任何副作用 —— 一旦漏了这道判断，每一台机器都会在某个目录下悄悄
 *    长一个越来越大的文件，而没有任何地方会报错。
 * 2. **不许把正文写进去。** 这个文件是拿去算账的，会被拷来拷去；提示词和答复是公司
 *    经营内容。检索式只留前 60 个字符 —— 那点长度够对上是哪一轮，不够复原问了什么。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { costTapPath, tapModelCall, tapSearchCall } from "./cost-tap";

let dir = "";
const tap = () => join(dir, "cost.jsonl");
/** 写盘是 `void append(...)`，异步。等一拍再读。 */
const settle = () => new Promise((r) => setTimeout(r, 30));

const row = {
  hint: "a4.draft",
  slot: "alt",
  alias: "claude-opus-5",
  model: "us.anthropic.claude-opus-5",
  inputTokens: 1615,
  outputTokens: 8000,
  cachedInputTokens: 0,
  reasoningTokens: 1284,
  ms: 154_621,
  ok: true,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkos-cost-tap-"));
  delete process.env.TKOS_COST_TAP;
  delete process.env.TKOS_COST_STAGE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TKOS_COST_TAP;
  delete process.env.TKOS_COST_STAGE;
});

describe("默认关着", () => {
  it("没配 TKOS_COST_TAP 时一个字节都不写", async () => {
    expect(costTapPath()).toBe("");
    tapModelCall(row);
    tapSearchCall({ provider: "bocha", query: "随便什么", hits: 6, ms: 2600, ok: true });
    await settle();
    // 不是「那个文件是空的」，是**整个目录里什么都没长出来**。
    expect(readdirSync(dir)).toEqual([]);
  });

  it("配成空串或全是空格也当没配", async () => {
    for (const v of ["", "   "]) {
      process.env.TKOS_COST_TAP = v;
      expect(costTapPath()).toBe("");
      tapModelCall(row);
    }
    await settle();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("开着的时候记什么", () => {
  beforeEach(() => {
    process.env.TKOS_COST_TAP = tap();
    process.env.TKOS_COST_STAGE = "A4-深研";
  });

  it("一次调用一行，段名和四种 token 都在", async () => {
    tapModelCall(row);
    await settle();
    const lines = readFileSync(tap(), "utf8").trim().split(String.fromCharCode(10));
    expect(lines).toHaveLength(1);
    const got = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(got.stage).toBe("A4-深研");
    expect(got.kind).toBe("model");
    expect(got.alias).toBe("claude-opus-5");
    // 四种 token 一个都不能少 —— 少一种就算不出钱（缓存命中和新输入是两个单价）。
    expect(got.inputTokens).toBe(1615);
    expect(got.outputTokens).toBe(8000);
    expect(got.cachedInputTokens).toBe(0);
    expect(got.reasoningTokens).toBe(1284);
  });

  it("追加，不是覆盖 —— 一轮下来是几十行", async () => {
    tapModelCall(row);
    tapModelCall({ ...row, hint: "a4.plan" });
    tapSearchCall({ provider: "doubao", query: "灯塔项目 定价", hits: 8, ms: 3575, ok: true });
    await settle();
    const lines = readFileSync(tap(), "utf8").trim().split(String.fromCharCode(10));
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]).kind).toBe("search");
  });

  it("**检索式只留前 60 个字符**", async () => {
    const long = "灯".repeat(200);
    tapSearchCall({ provider: "bocha", query: long, hits: 0, ms: 100, ok: true });
    await settle();
    const got = JSON.parse(readFileSync(tap(), "utf8").trim()) as { query: string };
    expect(got.query).toHaveLength(60);
  });

  it("写不进去也不许抛 —— 量钱的东西不能把正经链路弄挂", async () => {
    // 指向一个不存在的目录：`appendFileSync` 会抛，而调用方一点感觉都不该有。
    process.env.TKOS_COST_TAP = join(dir, "没有这个目录", "cost.jsonl");
    expect(() => tapModelCall(row)).not.toThrow();
    await settle();
    expect(existsSync(join(dir, "没有这个目录"))).toBe(false);
  });
});
