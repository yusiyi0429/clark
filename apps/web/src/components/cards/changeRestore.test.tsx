import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TLocalChangedFile } from "@warmap/contracts";
import { LocalRunnerError } from "@/lib/local/runner";
import { createMockEdits } from "@/lib/local/mockChanges";
import { ChangedFiles } from "./ChangedFiles";
import { restorableChanges, restoreChanges } from "./FilePreview";

describe("恢复其中几处的三种结果（第 72 条）", () => {
  it("Word、Excel 转出来的（converted）、一轮正在跑时点改动不出「恢复」", () => {
    expect(restorableChanges("full", true)).toBe(true);
    expect(restorableChanges("converted", true)).toBe(false);
    expect(restorableChanges("full", false)).toBe(false);
  });
  it("成了：重读，不写话", async () => {
    const reload = vi.fn(async () => undefined);
    expect(await restoreChanges({ restore: async () => undefined }, ["c2"], "r1", reload)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("一轮正在跑（409）：写「这一轮还在跑」，不重读", async () => {
    const reload = vi.fn(async () => undefined);
    const busy = async () => { throw new LocalRunnerError("conflict", "这一轮还在跑", 409); };
    expect(await restoreChanges({ restore: busy }, ["c2"], "r1", reload)).toBe("这一轮还在跑");
    expect(reload).not.toHaveBeenCalled();
  });
  it("revision 对不上：重读，写「文件又变了」让本人重新看", async () => {
    const reload = vi.fn(async () => undefined);
    const changed = async () => { throw new LocalRunnerError("file_changed" as "conflict", "文件又变了", 409); };
    expect(await restoreChanges({ restore: changed }, ["c2"], "r1", reload)).toBe("文件又变了");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("假本机：执行方改的文件、按处恢复、整个恢复（两个验收场景的数据）", () => {
  it("周报 2 处，第二处恢复以后「良好」回来、只剩第一处；旧的 revision 再恢复回「文件又变了」", () => {
    const edits = createMockEdits();
    // 第一轮只改周报；第二轮删一个、改三个；演完了回空。
    expect(edits.apply()).toEqual([{ path: "周报.md", changes: 2, change: "modified" }]);
    expect(edits.list("C:/work").map((file) => file.path)).toEqual(["周报.md"]);
    expect(edits.apply()).toEqual([
      { path: "旧安排.md", changes: 1, change: "deleted" }, { path: "合同.docx", changes: 1, change: "modified" },
      { path: "报表.xlsx", changes: 3, change: "modified" }, { path: "预算.xls", changes: null, change: "modified" },
    ]);
    expect(edits.pending()).toBe(false);
    const first = edits.read("周报.md", "turn")!;
    expect(first.after).toContain("| 进展评估 | 优秀 |");
    expect(edits.restoreChanges("周报.md", ["c2"], first.revision)).toBe("ok");
    const second = edits.read("周报.md", "turn")!;
    expect(second.after).toContain("| 进展评估 | 良好 |");
    expect(second.after).toContain("11 月 18 日（周三）");
    expect(second.changes.map((change) => change.id)).toEqual(["c1"]);
    expect(edits.restoreChanges("周报.md", ["c1"], first.revision)).toBe("changed");
  });
  it("Word、Excel 转出来的只能看，按处恢复回 converted；老格式只知道改过", () => {
    const edits = createMockEdits();
    edits.apply();
    edits.apply();
    const sheet = edits.read("报表.xlsx", "session")!;
    expect(sheet.detail).toBe("converted");
    expect(edits.restoreChanges("报表.xlsx", ["x1"], sheet.revision)).toBe("converted");
    expect(edits.read("预算.xls", "session")).toMatchObject({ detail: "none", before: null, after: null, changes: [] });
  });
  it("整个恢复：删掉的回来了、改了的回到原样，都标「已恢复」；Excel 开着时第一次回 in_use，别的照做", () => {
    const edits = createMockEdits();
    edits.apply();
    edits.apply();
    const result = edits.restoreFiles(["旧安排.md", "周报.md", "报表.xlsx"]);
    expect(result.restored).toEqual(["周报.md", "旧安排.md"]);
    expect(result.failed).toEqual([{ path: "报表.xlsx", reason: "in_use", message: "正被 Excel 打开，关掉再点" }]);
    const list = edits.list("C:/work");
    expect(list.find((file) => file.path === "旧安排.md")).toMatchObject({ exists: true, restoredAt: expect.any(String) });
    expect(list.find((file) => file.path === "周报.md")?.restoredAt).toEqual(expect.any(String));
    expect(list.find((file) => file.path === "报表.xlsx")?.restoredAt).toBeUndefined();
    expect(edits.restoreFiles(["报表.xlsx"]).restored).toEqual(["报表.xlsx"]);
  });
});

const file = (path: string, more: Partial<TLocalChangedFile> = {}): TLocalChangedFile =>
  ({ path, absolutePath: `C:/work/${path}`, sources: ["snapshot"], exists: true, size: 10, change: "modified", restorable: true, ...more });

describe("右栏「改动的文件」（第 71 条）", () => {
  const render = (props: Partial<Parameters<typeof ChangedFiles>[0]> = {}) => renderToStaticMarkup(
    <ChangedFiles files={[file("周报.md"), file("旧安排.md", { change: "deleted", exists: false, size: null }), file("报表.xlsx", { restoredAt: "2026-11-11T08:00:00Z" })]}
      canRestore current={null} onOpen={vi.fn()} onRestore={vi.fn()} {...props} />);
  it("每项标新建 / 改 / 删；能恢复的给「恢复」（删掉的也有），恢复过的写「已恢复」；顶上「全部恢复」", () => {
    const html = render();
    expect(html).toContain("改动的文件 3");
    expect(html).toMatch(/改<\/span><span[^>]*>周报\.md/);
    expect(html).toMatch(/删<\/span><span[^>]*>旧安排\.md/);
    expect((html.match(/data-testid="restore-file"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-testid="restored">已恢复');
    expect(html).toContain("全部恢复");
  });
  it("一轮正在跑、卡在工作树里（canRestore false）：没有「恢复」「全部恢复」", () => {
    const html = render({ canRestore: false });
    expect(html).not.toContain("restore-file");
    expect(html).not.toContain("全部恢复");
  });
  it("只给直接改的文件留了一份：这一组顶上写一行；卡在工作树里（没有 change）默认收起", () => {
    expect(render({ undo: { state: "touched_only", reason: "sync_folder" } })).toContain("只留了直接改的文件");
    const worktree = renderToStaticMarkup(<ChangedFiles files={[{ path: "a.ts", absolutePath: "C:/w/a.ts", sources: ["git"], exists: true, size: 1 }]} canRestore={false} current={null} onRestore={vi.fn()} />);
    expect(worktree).toContain("改动的文件 1");
    expect(worktree).not.toContain("a.ts");
  });
});
