import { describe, expect, it, vi } from "vitest";
import { UndoWindow } from "./undoWindow";

function setup() {
  const pending: { fn: () => void; ms: number }[] = [];
  const timers = { set: (fn: () => void, ms: number) => { const entry = { fn, ms }; pending.push(entry); return entry; },
    clear: (handle: unknown) => { const i = pending.indexOf(handle as never); if (i >= 0) pending.splice(i, 1); } };
  const onChange = vi.fn();
  return { window: new UndoWindow<"confirm" | "dismiss">(onChange, timers), pending, onChange, fire: () => pending.splice(0).forEach((entry) => entry.fn()) };
}

describe("会议页会后事项的撤回窗口（巡检 P1-9）", () => {
  it("先记住、5 秒到点才提交；撤回就什么都不发", () => {
    const { window, pending, fire } = setup();
    const commit = vi.fn();
    window.hold("i1", "confirm", commit);
    expect(window.pending("i1")).toBe("confirm");
    expect(pending[0].ms).toBe(5000);
    window.undo("i1");
    expect(window.pending("i1")).toBeNull();
    fire();
    expect(commit).not.toHaveBeenCalled();
    window.hold("i1", "dismiss", commit);
    fire();
    expect(commit).toHaveBeenCalledOnce();
    expect(window.pending("i1")).toBeNull();
  });

  it("同一条不会重复记；离开页面时还在等的立刻提交", () => {
    const { window, pending } = setup();
    const a = vi.fn(); const b = vi.fn();
    window.hold("i1", "confirm", a);
    window.hold("i1", "dismiss", b);
    window.hold("i2", "dismiss", b);
    expect(pending).toHaveLength(2);
    window.flush();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(0);
  });
});
