import { describe, expect, it } from "vitest";
import { isLockKey } from "./PersonMenu";

const key = (patch: Partial<Parameters<typeof isLockKey>[0]>) => ({ code: "KeyL", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, isComposing: false, ...patch });

describe("锁屏快捷键（19 节第 8 条）", () => {
  it("Ctrl+Shift+L、Mac 上 Cmd+Shift+L 锁屏；少了 Shift、多了 Alt、打字合成中都不算", () => {
    expect(isLockKey(key({ ctrlKey: true }))).toBe(true);
    expect(isLockKey(key({ metaKey: true }))).toBe(true);
    expect(isLockKey(key({ ctrlKey: true, shiftKey: false }))).toBe(false);
    expect(isLockKey(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isLockKey(key({ ctrlKey: true, isComposing: true }))).toBe(false);
    expect(isLockKey(key({ ctrlKey: true, metaKey: true }))).toBe(false);
    expect(isLockKey(key({ ctrlKey: true, code: "KeyK" }))).toBe(false);
  });
});
