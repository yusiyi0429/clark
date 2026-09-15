// src/lib/agent/talk/log.test.ts
import { describe, expect, it } from "vitest";
import { checkEntry } from "./point";

const ok = {
  turn: 3, trigger: "他指出前后口径混用", before: "更支持 A", after: "两说",
  kind: "partial", rationale: "口径统一之后差距缩到一个点内",
};

describe("让步日志", () => {
  it("判断变了但指不出触发物 —— 拒。这正是压力性让步的形状", () => {
    for (const bad of [
      "", "他不同意", "他又问了一遍", "他连着压了三轮", "他是一号位，他说不对",
      "对方不同意", "CEO 要求重新考虑", "领导不认可", "他说他不同意", "因为他不同意",
    ])
      expect(checkEntry({ ...ok, trigger: bad }).ok).toBe(false);
  });

  it("换个说法的真触发物照收 —— 拒绝表不许宽到把论证也扫进去", () => {
    for (const good of [
      "E7 的合同原文写的是含税价",
      "他举了一个反例：第三家没走准入也交付了",
      "他指出我把两个口径混着用",
      "领导班子那份决议里写的是含税价",
      "他指出我反复把两个口径混着用，这个问题在附录里",
      "一号位在 3 月的会上定的口径是含税价",
    ]) expect(checkEntry({ ...ok, trigger: good }).ok).toBe(true);
  });

  it("before === after 却记成让步 —— 拒", () => {
    expect(checkEntry({ ...ok, before: "同一句", after: "同一句", kind: "concede" }).ok).toBe(false);
  });

  it("坚持也要记：before === after 且 kind=hold 是合法的一条", () => {
    expect(checkEntry({ ...ok, before: "更支持 A", after: "更支持 A", kind: "hold" }).ok).toBe(true);
  });

  // 顶住压力这件事必须记得下来。压力本身就是 hold 那一条的 trigger 该写的东西 ——
  // 拒绝表只在判断真的变了时才拦。这一条同时钉住 Task 11 的 findDesync 拿到的输入形状。
  it("顶住压力那一条：trigger 写的就是压力，kind=hold 照收", () => {
    const r = checkEntry({ ...ok, trigger: "他连着压了三轮", before: "更支持 A", after: "更支持 A", kind: "hold" });
    expect(r.ok).toBe(true);
  });

  it("轮次要是正整数", () => {
    expect(checkEntry({ ...ok, turn: 0 }).ok).toBe(false);
  });

  it("空串在任何 kind 下都不算触发物", () => {
    expect(checkEntry({ ...ok, trigger: "", before: "更支持 A", after: "更支持 A", kind: "hold" }).ok).toBe(false);
  });

  it("纯空白符也不算触发物 —— checkEntry 和 isTrigger 必须一致", () => {
    for (const ws of ["   ", "\t", "\n", " \t\n "])
      expect(checkEntry({ ...ok, trigger: ws, kind: "partial" }).ok).toBe(false);
  });
});
