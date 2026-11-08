import { afterEach, describe, expect, it, vi } from "vitest";
import { NAME_TIP_MS, isTruncated, nameTip } from "./NameTip";

afterEach(() => vi.useRealTimers());

describe("左栏标题截断时悬停出完整名字", () => {
  it("截断了：进来约 500ms 后出，出去就收", () => {
    vi.useFakeTimers();
    const setOpen = vi.fn();
    const tip = nameTip(() => true, setOpen);
    tip.enter();
    vi.advanceTimersByTime(NAME_TIP_MS - 1);
    expect(setOpen).not.toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(1);
    expect(setOpen).toHaveBeenLastCalledWith(true);
    tip.leave();
    expect(setOpen).toHaveBeenLastCalledWith(false);
    expect(NAME_TIP_MS).toBe(500);
  });

  it("没截断：不出提示；没等到时间就移开也不出", () => {
    vi.useFakeTimers();
    const setOpen = vi.fn();
    nameTip(() => false, setOpen).enter();
    vi.advanceTimersByTime(NAME_TIP_MS * 2);
    expect(setOpen).not.toHaveBeenCalledWith(true);
    const quick = nameTip(() => true, setOpen);
    quick.enter();
    vi.advanceTimersByTime(NAME_TIP_MS / 2);
    quick.leave();
    vi.advanceTimersByTime(NAME_TIP_MS);
    expect(setOpen).not.toHaveBeenCalledWith(true);
  });

  it("截没截断按字比框宽不宽算", () => {
    expect(isTruncated({ scrollWidth: 240, clientWidth: 180 })).toBe(true);
    expect(isTruncated({ scrollWidth: 180, clientWidth: 180 })).toBe(false);
    expect(isTruncated(null)).toBe(false);
  });
});
