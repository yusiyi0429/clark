import { describe, expect, it } from "vitest";
import { popReturn, trimReturns } from "./returnStack";

describe("返回栈跟着浏览器后退（巡检 P1-4）", () => {
  it("已处理 → 议题 → 后退 → 会议 → 后退：× 回首页，不再 push 当前页", () => {
    let stack: string[] = [];
    stack.push("/archive");                    // 已处理里打开议题
    stack = trimReturns(stack, "/issues/a");
    stack = trimReturns(stack, "/archive");    // 浏览器后退
    expect(stack).toEqual([]);
    stack.push("/archive");                    // 再打开会议
    stack = trimReturns(stack, "/meetings/m");
    stack = trimReturns(stack, "/archive");    // 再后退
    expect(popReturn(stack, "/archive")).toEqual({ back: null, rest: [] });
  });

  it("栈和地址栏脱节时，关闭跳过就是当前页的记录", () => {
    expect(popReturn(["/archive", "/archive"], "/archive")).toEqual({ back: null, rest: [] });
    expect(popReturn(["/meetings/m", "/archive"], "/archive")).toEqual({ back: "/meetings/m", rest: [] });
  });

  it("后退到中间一页时只丢它和它之后的记录", () => {
    expect(trimReturns(["/archive", "/meetings/m"], "/meetings/m")).toEqual(["/archive"]);
    expect(trimReturns(["/archive"], "/issues/a")).toEqual(["/archive"]);
  });
});
