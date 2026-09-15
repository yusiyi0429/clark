/*
 * 这个文件**不摸 store**（`delta.ts` 只依赖 `rules.ts` 与 `overlap.ts` 两个零依赖叶子），
 * 所以不需要 demo 档那套「环境变量在最前、真模块在 beforeAll 里 await import」的姿态。
 */
import { describe, expect, it } from "vitest";
import { declareDelta, SAME_MIN, SEPARATE_MAX } from "./delta";

describe("declareDelta", () => {
  it("纯转载 —— 判成同一条，且一个字的增量都没有", () => {
    const text = "某公司发布了 agent 编排产品，面向国内中大型客户。";
    const r = declareDelta({ incoming: text, existing: text });
    expect(r.verdict).toBe("merged");
    expect(r.delta).toEqual([]);
    expect(r.overlap).toBeGreaterThanOrEqual(SAME_MIN);
  });

  it("同一件事但多了一句新的 —— 并进去，并说清多了哪一句", () => {
    const r = declareDelta({
      existing: "某公司发布了 agent 编排产品，面向国内中大型客户。",
      incoming: "某公司发布了 agent 编排产品，面向国内中大型客户。首批签了三家银行。",
    });
    expect(r.verdict).toBe("merged");
    expect(r.delta).toEqual(["首批签了三家银行。"]);
  });

  it("完全是另一件事 —— 自成一条", () => {
    const r = declareDelta({
      existing: "某公司发布了 agent 编排产品，面向国内中大型客户。",
      incoming: "监管出了新规，要求金融机构的模型调用留全量日志。",
    });
    expect(r.verdict).toBe("separate");
    expect(r.overlap).toBeLessThan(SEPARATE_MAX);
  });

  it("既有那一份是空的 —— 自成一条（没有可并的东西）", () => {
    expect(declareDelta({ existing: "", incoming: "任何一句话。" }).verdict).toBe("separate");
  });

  it("增量里不含既有那份已经说过的句子", () => {
    const r = declareDelta({
      existing: "甲发布了产品。乙签了银行。",
      incoming: "乙签了银行。甲发布了产品。丙拿了新一轮融资。",
    });
    expect(r.delta).toEqual(["丙拿了新一轮融资。"]);
  });
});
