/**
 * 闸门那三条硬性质：**结果保序、同时在飞的数量有上限、异常不吞**。
 *
 * 保序那一条是台账编号的地基（见 `pool.ts` 头部）：谁先回来谁先记的话，同一批页跑两遍
 * 会得到两套 `E#`，而报告正文引的是编号。所以这里故意让后面的先返回。
 */
import { describe, expect, it } from "vitest";

import { mapPool } from "./pool";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("mapPool", () => {
  it("先回来的不许插队：结果按输入下标回填", async () => {
    // 倒着排等待时间：最后一个最先返回。
    const items = [40, 30, 20, 10];
    const out = await mapPool(items, 4, async (ms, i) => {
      await tick(ms);
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:40", "1:30", "2:20", "3:10"]);
  });

  it("同时在飞的不超过闸门宽度，而且跑完一个补一个", async () => {
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    await mapPool(Array.from({ length: 9 }, (_, i) => i), 3, async (i) => {
      started.push(i);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
      return i;
    });
    expect(peak).toBe(3);
    // 补位是按下标往后领的，所以开工顺序就是输入顺序。
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("闸门宽度不合法时按串着跑，不是不限", async () => {
    let peak = 0;
    let inFlight = 0;
    const run = (limit: number) =>
      mapPool([1, 2, 3], limit, async (x) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick(1);
        inFlight -= 1;
        return x;
      });
    expect(await run(0)).toEqual([1, 2, 3]);
    expect(await run(-5)).toEqual([1, 2, 3]);
    expect(await run(Number.NaN)).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("空输入不起 worker", async () => {
    let calls = 0;
    expect(
      await mapPool([], 4, async () => {
        calls += 1;
        return 1;
      })
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it("不吞异常：一个抛出来整批跟着抛", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("这一个坏了");
        await tick(1);
        return x;
      })
    ).rejects.toThrow("这一个坏了");
  });
});
