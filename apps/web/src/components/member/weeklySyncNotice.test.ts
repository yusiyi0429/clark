import { beforeEach, describe, expect, it, vi } from "vitest";
import { weeklySyncNotices } from "./weeklySyncNotice";

describe("周五兜底提醒卡", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it("没有提醒时为空", () => expect(weeklySyncNotices(null)).toEqual([]));

  it("没有连接：按钮打开连接对话框", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const [notice] = weeklySyncNotices({ reason: "no_connection" });
    expect(notice.buttons[0].label).toBe("连接你的 Agent");
    expect(await notice.buttons[0].run()).toEqual({ ok: true, settled: "已打开连接设置" });
    expect(dispatchEvent.mock.calls[0][0].type).toBe("open-connection-dialog");
  });

  it("连了没同步：按钮复制同步指令", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const [notice] = weeklySyncNotices({ reason: "not_synced" });
    expect(notice.detail).toBe("");
    expect(await notice.buttons[0].run()).toEqual({ ok: true, settled: "已复制同步指令" });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("append_progress"));
  });
});
