/**
 * 可见性表必须和 `api` 的键一一对应。
 *
 * 类型上 `Record<RpcMethod, Scope>` 已经保证「少一个就编译不过」；这个测试管的是
 * 另一半 —— 表里多出一个已经删掉的方法名（那会让人以为某个门还关着）。
 */
import { describe, expect, it } from "vitest";

import { METHOD_SCOPE, scopeOf } from "./scope";
import { api } from "./store";

const rpcMethods = Object.entries(api)
  .filter(([, v]) => typeof v === "function")
  .map(([k]) => k)
  .sort();

describe("METHOD_SCOPE", () => {
  it("每个 RPC 方法都分了类", () => {
    expect(rpcMethods.filter((m) => !(m in METHOD_SCOPE))).toEqual([]);
  });

  it("表里没有已经不存在的方法", () => {
    expect(Object.keys(METHOD_SCOPE).sort().filter((m) => !rpcMethods.includes(m))).toEqual([]);
  });

  it("`today` 不在表里 —— 它是常量不是 RPC（见 client.ts）", () => {
    expect("today" in METHOD_SCOPE).toBe(false);
  });

  it("会议闭环那几个只有一号位", () => {
    expect(scopeOf("signClosure")).toBe("ceo");
    expect(scopeOf("confirmClosure")).toBe("ceo");
    expect(scopeOf("confirmBoardJudgement")).toBe("ceo");
    expect(scopeOf("resetDemo")).toBe("ceo");
  });

  it("不认识的方法名回 null，由调用方决定怎么拒", () => {
    expect(scopeOf("dropDatabase")).toBeNull();
  });
});
