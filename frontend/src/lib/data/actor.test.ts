/**
 * 请求作用域的 actor。
 *
 * 为什么要有它：`viewer()` 原来是常量（一号位），所有写操作都盖他的名字。
 * DRI 进来之后「谁写的」必须是真的 —— 但 70 处调用点不能改，所以身份从
 * 请求入口塞进 AsyncLocalStorage，`viewer()` 从那里读，默认值仍是一号位。
 */
import { describe, expect, it } from "vitest";

import { currentActor, runAsActor } from "./actor";

describe("runAsActor", () => {
  it("作用域外面是 null —— 没有身份不等于是一号位，那个回落归 store 决定", () => {
    expect(currentActor()).toBeNull();
  });

  it("作用域里读到的就是塞进去的那个", () => {
    const got = runAsActor({ personId: "PSN-06", role: "dri" }, () => currentActor());
    expect(got).toEqual({ personId: "PSN-06", role: "dri" });
    // 出了作用域立刻还原，不残留。
    expect(currentActor()).toBeNull();
  });

  it("两个并发的作用域不串", async () => {
    const slow = runAsActor({ personId: "PSN-06", role: "dri" }, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return currentActor()?.personId;
    });
    const fast = runAsActor({ personId: "PSN-02", role: "dri" }, async () => {
      return currentActor()?.personId;
    });
    expect(await fast).toBe("PSN-02");
    expect(await slow).toBe("PSN-06");
  });
});
