import { describe, expect, it, vi } from "vitest";
import { deliverMarkdown } from "./deliverMarkdown";

describe("周报 Markdown", () => {
  it("剪贴板能用就复制，不下载", async () => {
    const download = vi.fn();
    const writeText = vi.fn(async () => undefined);
    expect(await deliverMarkdown("# 周报", "a.md", { clipboard: { writeText }, download })).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("# 周报");
    expect(download).not.toHaveBeenCalled();
  });

  it("剪贴板被拒或没有剪贴板时直接下载 .md", async () => {
    const download = vi.fn();
    expect(await deliverMarkdown("# 周报", "a.md", { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } }, download })).toBe("downloaded");
    expect(await deliverMarkdown("# 周报", "b.md", { download })).toBe("downloaded");
    expect(download.mock.calls).toEqual([["# 周报", "a.md"], ["# 周报", "b.md"]]);
  });
});
