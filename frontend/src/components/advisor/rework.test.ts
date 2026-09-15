import { describe, expect, it } from "vitest";

import { armsRework, nextStage, type ReworkStage } from "./rework";

/**
 * 「打回重研」那颗键的闸。测的是**哪一下会真的花钱**。
 *
 * 这一栏里其余的东西点错了都可以再点回来（换个看法、展开一份清单）；这一颗按下去会丢掉
 * 现有报告、起一轮十几分钟的深研。而它跑起来的样子和他自己想要的那一轮长得一模一样 ——
 * 误起的一轮在屏幕上没有任何症状，只有月底的账单看得出来。所以这几条断言存在。
 */
describe("打回重研：起深研必须由他按下确认那一下", () => {
  it("第一下只开确认卡，不起轮", () => {
    /*
     * 变异验证：把 `armsRework` 改成 `press === "confirm" || press === "open"`
     * （也就是那颗键直接起轮，取消两下的设计）→ 这一条红。
     */
    expect(armsRework("idle", "open")).toBe(false);
    expect(nextStage("idle", "open")).toBe("confirming");
  });

  it("确认那一下才起，而且只有卡开着时算数", () => {
    expect(armsRework("confirming", "confirm")).toBe(true);
    expect(nextStage("confirming", "confirm")).toBe("running");
    /*
     * 没开卡就收到一次 confirm：屏幕上不该发生（确认键只在卡上），真发生了说明卡的
     * 渲染条件被改松了 —— 那时候宁可这一下不起轮。
     *
     * 变异验证：把 `armsRework` 改成 `press === "confirm"` → 这一条红。
     */
    expect(armsRework("idle", "confirm")).toBe(false);
    expect(nextStage("idle", "confirm")).toBe("idle");
  });

  it("算了就是算了，不起轮也不留在卡上", () => {
    expect(armsRework("confirming", "cancel")).toBe(false);
    expect(nextStage("confirming", "cancel")).toBe("idle");
  });

  it("已经在跑的时候一下都不算数 —— 双击不许变成两轮深研", () => {
    /*
     * 变异验证：删掉 `nextStage` 里 `if (stage === "running") return "running"` 那一句
     * 并让 `armsRework` 不看 stage → 「running + confirm」会再起一轮，这一条红。
     */
    const presses = ["open", "confirm", "cancel"] as const;
    for (const p of presses) {
      expect(armsRework("running", p)).toBe(false);
      expect(nextStage("running", p)).toBe("running");
    }
  });

  it("三档里只有一种组合会起轮 —— 全表点一遍，别的一律不起", () => {
    const stages: ReworkStage[] = ["idle", "confirming", "running"];
    const fired = stages.flatMap((s) =>
      (["open", "confirm", "cancel"] as const).filter((p) => armsRework(s, p)).map((p) => `${s}+${p}`),
    );
    // 恒为 true 的实现（`() => true`）会让这里出九条，恒为 false 的会出零条。
    expect(fired).toEqual(["confirming+confirm"]);
  });
});
