import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { foldEvents } from "@/lib/local/sessionView";
import type { TurnFile } from "@/lib/local/fileChanges";
import { TurnFilesContext, TurnFilesLine, latestFilesSeq, turnFileText } from "./TurnFiles";

const at = "2026-11-11T08:00:00Z";
const tf = (path: string, change: TurnFile["change"] = "modified", count: number | null = 1, detail: TurnFile["detail"] = "full"): TurnFile => ({ path, absolutePath: `C:/w/${path}`, change, detail, count });

describe("对话里一轮末尾那一行（第 72 条，事件 files_changed）", () => {
  it("files_changed 记成一条 files（带轮号、没列全的个数）；没有这个事件的轮不出", () => {
    const view = foldEvents([
      { seq: 1, at, type: "assistant_text", text: "改好了" },
      { seq: 2, at, type: "files_changed", turn: 1, files: [tf("docs/周报.md", "modified", 2)], more: 0 },
      { seq: 3, at, type: "turn_end", isError: false, text: null, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null } },
      { seq: 4, at, type: "assistant_text", text: "这一轮没动文件" },
    ] as never);
    expect(view.entries.map((entry) => entry.kind)).toEqual(["assistant", "files", "assistant"]);
    expect(view.entries[1]).toMatchObject({ kind: "files", turn: 1, more: 0 });
    expect(latestFilesSeq(view.entries)).toBe(2);
  });

  it("开了新一轮（后面来了本人的话）以后不再算最近一轮：那一行停在最后读到的处数，不去重读", () => {
    // 真本机对更早的一轮给的是当时的改动，不扣恢复过的：重读会让「2 处」跳回「3 处」。
    const events = [
      { seq: 1, at, type: "user_message", text: "改周报" },
      { seq: 2, at, type: "files_changed", turn: 1, files: [tf("周报.md", "modified", 3)], more: 0 },
    ];
    expect(latestFilesSeq(foldEvents(events as never).entries)).toBe(2);
    expect(latestFilesSeq(foldEvents([...events, { seq: 3, at, type: "user_message", text: "接着改" }] as never).entries)).toBeNull();
  });

  it("字：改了几处、新建、删了、只知道改过的不写处数、恢复过或剩 0 处的写「已恢复」", () => {
    expect(turnFileText(tf("docs/周报.md", "modified", 2), false)).toBe("改了 周报.md · 2 处");
    expect(turnFileText(tf("新的.md", "added"), false)).toBe("新建 新的.md");
    expect(turnFileText(tf("旧安排.md", "deleted"), false)).toBe("删了 旧安排.md");
    expect(turnFileText(tf("预算.xls", "modified", null, "none"), false)).toBe("改了 预算.xls");
    expect(turnFileText(tf("周报.md", "modified", 2), true)).toBe("改了 周报.md · 已恢复");
    expect(turnFileText(tf("周报.md", "modified", 0), false)).toBe("改了 周报.md · 已恢复");
  });

  it("多个文件各一行；超过 3 个（算上没列全的）收成「改了 N 个文件 ›」", () => {
    const view = { open: () => undefined, restored: (path: string) => path === "b.md", latest: 9 };
    const render = (files: TurnFile[], more = 0) => renderToStaticMarkup(<TurnFilesContext.Provider value={view}><TurnFilesLine seq={9} turn={2} files={files} more={more} /></TurnFilesContext.Provider>);
    const three = render(["a.md", "b.md", "c.md"].map((path) => tf(path)));
    expect(three.match(/data-testid="turn-file"/g)).toHaveLength(3);
    expect(three).toContain("改了 a.md · 1 处 ›");
    expect(three).toContain("改了 b.md · 已恢复 ›");
    expect(render(["a", "b", "c", "d", "e"].map((path) => tf(`${path}.md`)))).toContain("改了 5 个文件 ›");
    expect(render([tf("a.md"), tf("b.md")], 98)).toContain("改了 100 个文件 ›");
  });

  it("没有看文件的地方（专题会话页，没包 TurnFilesContext）：只写字、不能点", () => {
    const html = renderToStaticMarkup(<TurnFilesLine seq={1} turn={1} files={[tf("周报.md", "modified", 2)]} more={0} />);
    expect(html).toContain("改了 周报.md · 2 处");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("›");
  });
});
