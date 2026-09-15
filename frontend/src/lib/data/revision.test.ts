/**
 * 「库改过了」那个号。
 *
 * 这里管的是三件会让屏幕出错的事：**连写只推一帧**（否则一次确认会让屏幕重问四轮）、
 * **退订要真的退掉**（否则一条断掉的 SSE 会永远挂在名单上，`/api/health` 报的数字从此
 * 是假的）、**一个订阅者抛错不连坐另一个**（否则一块屏幕出错会让其他所有屏幕停止刷新）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bumpRevision,
  revision,
  revisionListenerCount,
  subscribeRevision,
} from "./revision";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bumpRevision", () => {
  it("同一小段时间里的连写只推一帧，帧上是最后那个号", () => {
    const seen: number[] = [];
    const off = subscribeRevision((rev) => seen.push(rev));

    // 一次确认在服务端是好几笔写（判断、议题、时间线、决定各一次 persistSoon）。
    bumpRevision();
    bumpRevision();
    bumpRevision();
    expect(seen).toEqual([]); // 还没到点，一帧都不该出去

    vi.advanceTimersByTime(60);
    expect(seen).toEqual([revision()]);

    off();
  });

  it("隔开的两次动作是两帧，号一直往上走", () => {
    const seen: number[] = [];
    const off = subscribeRevision((rev) => seen.push(rev));

    bumpRevision();
    vi.advanceTimersByTime(60);
    bumpRevision();
    vi.advanceTimersByTime(60);

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]!);
    expect(seen[1]).toBe(revision());

    off();
  });

  it("没人在听也不炸", () => {
    expect(revisionListenerCount()).toBe(0);
    expect(() => {
      bumpRevision();
      vi.advanceTimersByTime(60);
    }).not.toThrow();
  });
});

describe("subscribeRevision", () => {
  it("退订之后不再收 —— 名单上的数字要跟着降回去", () => {
    const seen: number[] = [];
    const off = subscribeRevision((rev) => seen.push(rev));
    expect(revisionListenerCount()).toBe(1);

    off();
    expect(revisionListenerCount()).toBe(0);

    bumpRevision();
    vi.advanceTimersByTime(60);
    expect(seen).toEqual([]);
  });

  it("在回调里退订不会漏掉后面那几个", () => {
    // SSE 那一头断了就是在回调里退订（push 写不出去 → close → off），
    // 而它可能是名单上的第一个。
    const seen: string[] = [];
    const offFirst = subscribeRevision(() => {
      seen.push("first");
      offFirst();
    });
    const offSecond = subscribeRevision(() => seen.push("second"));

    bumpRevision();
    vi.advanceTimersByTime(60);

    expect(seen).toEqual(["first", "second"]);
    offSecond();
  });

  it("一个订阅者抛错，另一个照旧收到", () => {
    const seen: string[] = [];
    const offBad = subscribeRevision(() => {
      throw new Error("这一头炸了");
    });
    const offGood = subscribeRevision(() => seen.push("good"));

    bumpRevision();
    expect(() => vi.advanceTimersByTime(60)).not.toThrow();
    expect(seen).toEqual(["good"]);

    offBad();
    offGood();
  });
});
