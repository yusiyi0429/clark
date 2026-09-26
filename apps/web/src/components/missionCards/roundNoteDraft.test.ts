import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRoundNote, readRoundNote, saveRoundNote } from "./roundNoteDraft";

const values = new Map<string, string>();
beforeEach(() => { values.clear(); vi.stubGlobal("sessionStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }); });
afterEach(() => vi.unstubAllGlobals());

describe("未提交的协作核对草稿", () => {
  it("同一拍板人跨卡共用轮次草稿，换人、战场或轮次互不带入", () => {
    saveRoundNote("ceo", "round-a", 1, "双方已核对边界。");
    expect(readRoundNote("ceo", "round-a", 1)).toBe("双方已核对边界。");
    expect(readRoundNote("member", "round-a", 1)).toBe("");
    expect(readRoundNote("ceo", "round-b", 1)).toBe("");
    expect(readRoundNote("ceo", "round-a", 2)).toBe("");
  });
  it("重开或确认后只清除此人的这一轮草稿", () => {
    saveRoundNote("ceo", "round-a", 1, "本轮结论");
    saveRoundNote("ceo", "round-b", 1, "另一战场结论");
    clearRoundNote("ceo", "round-a", 1);
    expect(readRoundNote("ceo", "round-a", 1)).toBe("");
    expect(readRoundNote("ceo", "round-b", 1)).toBe("另一战场结论");
  });
  it("存储被浏览器禁止时不影响页面写入与拍板", () => {
    vi.stubGlobal("sessionStorage", { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); }, removeItem: () => { throw Error("blocked"); } });
    expect(readRoundNote("ceo", "round-a", 1)).toBe("");
    expect(() => saveRoundNote("ceo", "round-a", 1, "待提交")).not.toThrow();
    expect(() => clearRoundNote("ceo", "round-a", 1)).not.toThrow();
  });
});
