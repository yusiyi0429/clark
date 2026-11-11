import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { foldEvents } from "@/lib/local/sessionView";
import type { TurnFile } from "@/lib/local/fileChanges";
import { TurnFilesContext, TurnFilesLine, latestFilesSeq, turnFileText } from "./TurnFiles";

const at = "2026-11-11T08:00:00Z";
const report: TurnFile = { path: "docs/周报.md", changes: 2, change: "modified" };

describe("对话里一轮末尾那一行（第 72 条）", () => {
  it("这一轮改过文件才出：turn_files 记成一条 files；没改文件的轮不出", () => {
    const view = foldEvents([
      { seq: 1, at, type: "assistant_text", text: "改好了" },
      { seq: 2, at, type: "turn_files", files: [report] },
      { seq: 3, at, type: "turn_end", isError: false, text: null, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } },
      { seq: 4, at, type: "turn_files", files: [] },
    ] as never);
    expect(view.entries.map((entry) => entry.kind)).toEqual(["assistant", "files"]);
    expect(latestFilesSeq(view.entries)).toBe(2);
  });

  it("字：改了几处、新建、删了、只知道改过的不写处数、恢复过的写「已恢复」", () => {
    expect(turnFileText(report, false)).toBe("改了 周报.md · 2 处");
    expect(turnFileText({ path: "新的.md", changes: 1, change: "added" }, false)).toBe("新建 新的.md");
    expect(turnFileText({ path: "旧安排.md", changes: 1, change: "deleted" }, false)).toBe("删了 旧安排.md");
    expect(turnFileText({ path: "预算.xls", changes: null, change: "modified" }, false)).toBe("改了 预算.xls");
    expect(turnFileText(report, true)).toBe("改了 周报.md · 已恢复");
  });

  it("多个文件各一行；超过 3 个收成「改了 N 个文件 ›」", () => {
    const view = { open: () => undefined, restored: (path: string) => path === "b.md", latest: 9 };
    const render = (files: TurnFile[]) => renderToStaticMarkup(<TurnFilesContext.Provider value={view}><TurnFilesLine seq={9} files={files} /></TurnFilesContext.Provider>);
    const three = render(["a.md", "b.md", "c.md"].map((path) => ({ path, changes: 1, change: "modified" as const })));
    expect(three.match(/data-testid="turn-file"/g)).toHaveLength(3);
    expect(three).toContain("改了 a.md · 1 处 ›");
    expect(three).toContain("改了 b.md · 已恢复 ›");
    const five = render(["a", "b", "c", "d", "e"].map((path) => ({ path: `${path}.md`, changes: 1, change: "modified" as const })));
    expect(five).toContain("改了 5 个文件 ›");
    expect(five).not.toContain("turn-file\"");
  });
});
