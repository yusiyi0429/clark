import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ PATCH: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { hiddenSignalToast } from "./SignalCard";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("信号「不再出现在阅读列表」给提示与撤销（巡检 P1-15）", () => {
  it("撤销把状态改回，并让外壳刷新列表", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    api.PATCH.mockResolvedValue({ response: { ok: true } });
    const toast = hiddenSignalToast("sig-1");
    expect(toast.text).toBe("这条信号已从阅读列表移除");
    expect(toast.action?.label).toBe("撤销");
    await toast.action!.run();
    expect(api.PATCH).toHaveBeenCalledWith("/api/signals/{id}/state", { params: { path: { id: "sig-1" } }, body: { dismissed: false } });
    const types = dispatchEvent.mock.calls.map(([event]) => (event as Event).type);
    expect(types).toEqual(["workspace-refresh", "workspace-toast"]);
    expect((dispatchEvent.mock.calls[1][0] as CustomEvent<{ text: string }>).detail.text).toBe("已恢复到阅读列表");
  });

  it("撤销失败时说明没恢复，不刷新", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    api.PATCH.mockResolvedValue({ response: { ok: false } });
    await hiddenSignalToast("sig-1").action!.run();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect((dispatchEvent.mock.calls[0][0] as CustomEvent<{ text: string }>).detail.text).toBe("恢复失败，请稍后重试");
  });
});
