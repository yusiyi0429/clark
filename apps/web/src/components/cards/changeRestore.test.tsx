import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TLocalChangedFile } from "@warmap/contracts";
import type { FileChanges } from "@/lib/local/fileChanges";
import { LocalRunnerError } from "@/lib/local/runner";
import { createMockEdits } from "@/lib/local/mockChanges";
import { ChangedFiles } from "./ChangedFiles";
import { restoreChanges, restoreKind, restoreWholeFile } from "./FilePreview";

const read = (more: Partial<FileChanges> = {}): FileChanges => ({
  path: "周报.md", absolutePath: "C:/w/周报.md", range: "turn", turn: 1, change: "modified", detail: "full", before: "a", after: "b",
  changes: [{ id: "c1", before: { start: 0, end: 1 }, after: { start: 0, end: 1 } }], revision: "r1", restorable: true, ...more,
});

describe("点改过的地方出哪个恢复（主会话 11/11：点了就出能做的那个）", () => {
  it("文本类能按处恢复出「恢复」；看更早一轮、之后又改过的（restorable false）不出", () => {
    expect(restoreKind(read(), true, true)).toBe("some");
    expect(restoreKind(read({ restorable: false }), true, true)).toBeNull();
  });
  it("Word、Excel 转出来的、整份新建、整份删掉的出「恢复整个文件」；右栏清单里不能恢复的不出", () => {
    expect(restoreKind(read({ detail: "converted", restorable: false }), true, true)).toBe("whole");
    expect(restoreKind(read({ change: "added", before: null, restorable: false }), true, true)).toBe("whole");
    expect(restoreKind(read({ change: "deleted", after: null, restorable: false }), true, true)).toBe("whole");
    expect(restoreKind(read({ detail: "converted" }), true, false)).toBeNull();
  });
  it("一轮正在跑什么都不出", () => {
    expect(restoreKind(read(), false, true)).toBeNull();
    expect(restoreKind(read({ detail: "converted" }), false, true)).toBeNull();
  });
});

describe("恢复其中几处的三种结果（第 72 条）", () => {
  it("成了：照本机回的新读结果重画，不重读、不写话", async () => {
    const show = vi.fn();
    const reload = vi.fn(async () => undefined);
    const next = read({ changes: [] });
    expect(await restoreChanges({ restore: async () => next }, ["c1"], "r1", show, reload)).toBeNull();
    expect(show).toHaveBeenCalledWith(next);
    expect(reload).not.toHaveBeenCalled();
  });
  it("一轮正在跑（409）：写「这一轮还在跑」，不重读", async () => {
    const reload = vi.fn(async () => undefined);
    const busy = async (): Promise<FileChanges> => { throw new LocalRunnerError("conflict", "这一轮还在跑", 409); };
    expect(await restoreChanges({ restore: busy }, ["c1"], "r1", vi.fn(), reload)).toBe("这一轮还在跑");
    expect(reload).not.toHaveBeenCalled();
  });
  it("revision 对不上（file_changed）：重读，写「文件又变了」让本人重新看", async () => {
    const reload = vi.fn(async () => undefined);
    const changed = async (): Promise<FileChanges> => { throw new LocalRunnerError("file_changed", "文件又变了", 409); };
    expect(await restoreChanges({ restore: changed }, ["c1"], "r1", vi.fn(), reload)).toBe("文件又变了");
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("恢复整个文件：成了重读；被占用照本机回的原因写；一轮在跑写「这一轮还在跑」", async () => {
    const reload = vi.fn(async () => undefined);
    expect(await restoreWholeFile({ restoreFile: async () => ({ restored: ["报表.xlsx"], failed: [] }) }, reload)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await restoreWholeFile({ restoreFile: async () => ({ restored: [], failed: [{ path: "报表.xlsx", reason: "in_use", message: "正被 Excel 打开，关掉再点" }] }) }, reload))
      .toBe("正被 Excel 打开，关掉再点");
    expect(await restoreWholeFile({ restoreFile: async () => { throw new LocalRunnerError("conflict", "x", 409); } }, reload)).toBe("这一轮还在跑");
  });
});

describe("假本机：执行方改的文件、按处恢复、整个恢复（两个验收场景的数据）", () => {
  it("第一轮周报 2 处；第二处恢复以后「良好」回来、只剩第一处；旧的 revision 再恢复回「文件又变了」", () => {
    const edits = createMockEdits("C:/w");
    expect(edits.apply()).toEqual({ turn: 1, files: [{ path: "周报.md", absolutePath: "C:/w/周报.md", change: "modified", detail: "full", count: 2 }] });
    const first = edits.read("周报.md", "turn", 1)!;
    expect(first).toMatchObject({ turn: 1, restorable: true });
    expect(first.after).toContain("| 进展评估 | 优秀 |");
    expect(edits.restoreChanges("周报.md", ["c2"], first.revision)).toBe("ok");
    const second = edits.read("周报.md", "turn", 1)!;
    expect(second.after).toContain("| 进展评估 | 良好 |");
    expect(second.after).toContain("11 月 18 日（周三）");
    expect(second.changes?.map((change) => change.id)).toEqual(["c1"]);
    expect(edits.restoreChanges("周报.md", ["c1"], first.revision)).toBe("changed");
  });
  it("第二轮：删一个、新建一个、Word、Excel、老格式；新建的 before 为 null，删掉的 after 为 null；只能整个恢复的按处恢复回 whole_only", () => {
    const edits = createMockEdits("C:/w");
    edits.apply();
    expect(edits.apply().files.map((file) => [file.path, file.change, file.detail, file.count])).toEqual([
      ["旧安排.md", "deleted", "full", 1], ["交接清单.md", "added", "full", 1], ["合同.docx", "modified", "converted", 1],
      ["报表.xlsx", "modified", "converted", 3], ["预算.xls", "modified", "none", null],
    ]);
    expect(edits.pending()).toBe(false);
    expect(edits.read("交接清单.md", "turn", 2)).toMatchObject({ before: null, change: "added", restorable: false });
    expect(edits.read("旧安排.md", "turn", 2)).toMatchObject({ after: null, change: "deleted", restorable: false });
    const sheet = edits.read("报表.xlsx", "session")!;
    expect(sheet).toMatchObject({ detail: "converted", restorable: false, turn: null });
    expect(edits.restoreChanges("报表.xlsx", ["x1"], sheet.revision)).toBe("whole_only");
    expect(edits.read("预算.xls", "session")).toMatchObject({ detail: "none" });
    expect(edits.read("预算.xls", "session")?.changes).toBeUndefined();
  });
  it("整个恢复：删掉的回来了、新建的删掉了、改了的回到原样，都标「已恢复」；Excel 开着时第一次回 in_use，别的照做", () => {
    const edits = createMockEdits("C:/w");
    edits.apply();
    edits.apply();
    const result = edits.restoreFiles(["周报.md", "旧安排.md", "交接清单.md", "报表.xlsx"]);
    expect(result.restored).toEqual(["周报.md", "旧安排.md", "交接清单.md"]);
    expect(result.failed).toEqual([{ path: "报表.xlsx", reason: "in_use", message: "正被 Excel 打开，关掉再点" }]);
    const list = edits.list();
    expect(list.find((file) => file.path === "旧安排.md")).toMatchObject({ exists: true, change: "deleted", restoredAt: expect.any(String) });
    expect(list.find((file) => file.path === "交接清单.md")).toMatchObject({ exists: false, change: "added", restoredAt: expect.any(String) });
    expect(list.find((file) => file.path === "周报.md")?.restoredAt).toEqual(expect.any(String));
    expect(list.find((file) => file.path === "报表.xlsx")?.restoredAt).toBeUndefined();
    expect(edits.restoreFiles(["报表.xlsx"]).restored).toEqual(["报表.xlsx"]);
  });
});

const file = (path: string, more: Partial<TLocalChangedFile> = {}): TLocalChangedFile =>
  ({ path, absolutePath: `C:/work/${path}`, sources: ["snapshot"], exists: true, size: 10, change: "modified", restorable: true, ...more });

describe("右栏「改动的文件」（第 71 条，主会话 11/11 的三处调整）", () => {
  const render = (props: Partial<Parameters<typeof ChangedFiles>[0]> = {}) => renderToStaticMarkup(
    <ChangedFiles files={[file("周报.md"), file("旧安排.md", { change: "deleted", exists: false, size: null }), file("交接清单.md", { change: "added" }),
      file("报表.xlsx", { restoredAt: "2026-11-11T08:00:00Z" })]}
      canRestore current={null} onOpen={vi.fn()} onRestore={vi.fn()} {...props} />);
  it("改了的不加字；新建的行尾一个淡色「新建」；不在了的划线；恢复过的写「已恢复」", () => {
    const html = render();
    expect(html).toContain("改动的文件 4");
    expect(html).toMatch(/>周报\.md<\/span><\/button>/);
    expect(html).toMatch(/data-gone="">旧安排\.md<\/span><\/button>/);
    expect(html).toMatch(/>交接清单\.md<\/span><span[^>]*data-testid="added">新建<\/span>/);
    expect(html).toContain('data-testid="restored">已恢复');
    expect(html).not.toMatch(/>改<\/span>|>删<\/span>/);
  });
  it("能恢复的给「恢复」（删掉的、新建的也有，恢复过的没有），按钮带悬停才显示的类；顶上「全部恢复」", () => {
    const html = render();
    expect(html.match(/data-testid="restore-file"/g)).toHaveLength(3);
    expect(html).toMatch(/<button[^>]*rowRestore[^>]*data-testid="restore-file"|<button[^>]*data-testid="restore-file"[^>]*rowRestore/);
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
