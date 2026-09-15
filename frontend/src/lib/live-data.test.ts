/**
 * 浏览器这一侧的「库改过了」。
 *
 * 这里管的是那条容易反过来的账：**刚挂上来的那一份不该马上重问一遍**（否则每开一页
 * 所有请求都发两遍），而**他不在的时候库改了的那一份，等他切回去必须补问**（否则屏幕
 * 上是旧的，而且因为 `revalidateIfStale: false` 再也不会自己变新）。
 */
import { describe, expect, it } from "vitest";

import { liveRefresh, liveRevision, noteRevision } from "./live-data";

/** 服务端又改了一次。号是全局单调的，所以测试之间只能往上走，不能设回去。 */
const bump = () => noteRevision(liveRevision() + 1);

describe("noteRevision", () => {
  it("只认更大的号 —— 重连时服务端会重报同一个", () => {
    bump();
    const at = liveRevision();
    noteRevision(at);
    noteRevision(at - 5);
    expect(liveRevision()).toBe(at);
  });

  it("读不懂的号（NaN）不动它", () => {
    const at = liveRevision();
    noteRevision(Number.NaN);
    expect(liveRevision()).toBe(at);
  });
});

describe("liveRefresh", () => {
  it("第一次挂上来不重问 —— 那一份就是这个号取的", () => {
    let asked = 0;
    const off = liveRefresh("first-mount", () => asked++);
    expect(asked).toBe(0);
    off();
  });

  it("挂着的时候库改了就重问", () => {
    let asked = 0;
    const off = liveRefresh("while-open", () => asked++);

    bump();
    expect(asked).toBe(1);
    bump();
    expect(asked).toBe(2);

    off();
  });

  it("他不在那一页的时候改的，切回去补问一轮", () => {
    let asked = 0;
    const ask = () => asked++;

    liveRefresh("away", ask)(); // 看过一眼就走了（订阅跟着卸掉）
    bump(); // 走了之后库改了
    expect(asked).toBe(0); // 没挂着，当场不问

    const off = liveRefresh("away", ask); // 切回来
    expect(asked).toBe(1);
    off();
  });

  it("走开期间改了很多次，切回去也只问一遍", () => {
    let asked = 0;
    const ask = () => asked++;

    liveRefresh("away-many", ask)();
    bump();
    bump();
    bump();

    const off = liveRefresh("away-many", ask);
    expect(asked).toBe(1);
    off();
  });

  it("两处用同一个 key，同一个号只问一遍", () => {
    // 议题头和报告栏都要那条议题 —— 同一个 key 两份订阅是常态。
    let asked = 0;
    const ask = () => asked++;
    const offA = liveRefresh("shared", ask);
    const offB = liveRefresh("shared", ask);

    bump();
    expect(asked).toBe(1);

    offA();
    offB();
  });

  it("退订之后不再问", () => {
    let asked = 0;
    liveRefresh("gone", () => asked++)();
    // 卸掉之后那一份还是「落后了」，但没人在看，所以现在不该发请求 ——
    // 它会等到下次挂上来才补（上面那条已经测了补的那一半）。
    bump();
    expect(asked).toBe(0);
  });
});
