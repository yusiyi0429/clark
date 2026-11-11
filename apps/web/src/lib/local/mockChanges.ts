/**
 * 假本机里「执行方改了文件」的那部分（设计第 71、72 条）：不在工作树里做的会话，一轮里改了周报（两处，一处是顺手把「良好」改成「优秀」）、
 * 删了一个旧文件、改了一份 Word 和一份 Excel（转成 Markdown 的明细，只能看）、动了一个老格式的表（只知道改过）。
 * 只照位置造数据，不比文本：每处改动记成「把第 n 个 find 换成 replace」，恢复一处就是去掉那一条再算一遍。
 * 报表.xlsx 第一次整个恢复时报「正被 Excel 打开」，再点一次才成（演「文件被占用」）。
 */
import type { TLocalChangedFile, TLocalRestoreFailure, TLocalSessionRestoreResponse } from "@warmap/contracts";
import type { FileChange, FileChanges, TurnFile } from "./fileChanges";
import { REPORT, edited } from "./fileChanges.fixture";

type Edit = { id: string; find: string; replace: string; nth?: number };
type MockFile = {
  path: string;
  detail: FileChanges["detail"];
  /** 会话动它之前的内容（Word、Excel 是转出来的 Markdown）。 */
  start: string;
  /** 还没恢复的改动。 */
  edits: Edit[];
  /** 被删掉了（没恢复）。 */
  deleted: boolean;
  restoredAt?: string;
  /** 整个恢复时先报一次「被占用」。 */
  lockOnce?: boolean;
  version: number;
};

const CONTRACT = ["# 采购合同", "", "## 一、付款", "", "- 付款期限：到货验收后 30 天内", "- 违约金：每日 0.5%", "", "## 二、交付", "", "交付地点：上海仓库。交付时间以双方确认的排期为准。", ""].join("\n");
const MONTHS = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
const SHEET = [
  "## 汇总", "",
  `| 项 | ${MONTHS.join(" | ")} | 合计 |`,
  `| --- | ${MONTHS.map(() => "---").join(" | ")} | --- |`,
  `| 收入 | ${MONTHS.map((_, i) => 120 + i * 5).join(" | ")} | =SUM(B2:M2) |`,
  `| 成本 | ${MONTHS.map((_, i) => 80 + i * 3).join(" | ")} | =SUM(B3:M3) |`,
  "| … | | | | | | | | | | | | | |",
  `| 毛利 | ${MONTHS.map((_, i) => `=${String.fromCharCode(66 + i)}2-${String.fromCharCode(66 + i)}3`).join(" | ")} | =SUM(B9:M9) |`,
  "",
  "## 说明", "", "数字单位：万元。", "",
].join("\n");

const initial = (): MockFile[] => [
  { path: "周报.md", detail: "full", start: REPORT, deleted: false, version: 1,
    edits: [{ id: "c1", find: "11 月 13 日（周五）", replace: "11 月 18 日（周三）" }, { id: "c2", find: "良好", replace: "优秀", nth: 1 }] },
  { path: "旧安排.md", detail: "full", start: "# 旧安排\n\n上线定在 11 月 13 日（周五）。\n", deleted: true, edits: [], version: 1 },
  { path: "合同.docx", detail: "converted", start: CONTRACT, deleted: false, version: 1, edits: [{ id: "w1", find: "30 天", replace: "45 天" }] },
  { path: "报表.xlsx", detail: "converted", start: SHEET, deleted: false, version: 1, lockOnce: true,
    edits: [{ id: "x1", find: "135", replace: "138" }, { id: "x2", find: "=SUM(B9:M9)", replace: "=SUM(B9:L9)" }, { id: "x3", find: "万元", replace: "元" }] },
  { path: "预算.xls", detail: "none", start: "", deleted: false, version: 1, edits: [{ id: "n1", find: "", replace: "" }] },
];

const now = () => new Date().toISOString();

/**
 * 一个会话的改动（假的），分两轮演：第一轮只改周报（验收第 10 条：「周报.md 2 处」）；
 * 本人再说一句，第二轮删旧安排.md、改 Word、Excel 和老格式的表（验收第 9 条，四个文件收成「改了 4 个文件」）。
 */
const ROUNDS = [["周报.md"], ["旧安排.md", "合同.docx", "报表.xlsx", "预算.xls"]];

export function createMockEdits() {
  const all = initial();
  const deletedAtFirst = new Set(all.filter((file) => file.deleted).map((file) => file.path));
  let files: MockFile[] = [];
  let round = 0;
  const find = (path: string) => files.find((file) => file.path === path) ?? null;
  /** 现在的样子：没恢复的改动照位置算出来，id 换回各自的。 */
  const current = (file: MockFile): { after: string; changes: FileChange[] } => {
    const made = edited(file.start, file.edits.map((edit) => [edit.find, edit.replace, edit.nth]));
    return { after: made.after, changes: made.changes.map((change) => ({ ...change, id: file.edits[Number(change.id.slice(1)) - 1]!.id })) };
  };
  /** 会话把它怎么了：恢复以后照旧是原来那样（删了的还写「删」）。 */
  const changeOf = (file: MockFile): TurnFile["change"] => (deletedAtFirst.has(file.path) ? "deleted" : "modified");
  const touched = (file: MockFile) => file.deleted || file.edits.length > 0;
  const restoreAll = (file: MockFile) => { file.edits = []; file.deleted = false; file.restoredAt = now(); file.version += 1; };

  return {
    /** 执行方下一轮动手，回这一轮改了哪些；两轮都演完了回空。 */
    apply(): TurnFile[] {
      const batch = all.filter((file) => ROUNDS[round]?.includes(file.path));
      round += 1;
      files = [...files, ...batch];
      return batch.map((file) => ({ path: file.path, changes: file.detail === "none" ? null : file.deleted ? 1 : file.edits.length, change: changeOf(file) }));
    },
    /** 还有没演的一轮。 */
    pending: () => round < ROUNDS.length,
    has: (path: string) => !!find(path),
    /** 右栏「改动的文件」：都有留一份、都能恢复。 */
    list(root: string): TLocalChangedFile[] {
      return files.map((file) => ({
        path: file.path, absolutePath: `${root}/${file.path}`, sources: ["snapshot"], exists: !file.deleted,
        size: file.deleted ? null : new TextEncoder().encode(file.detail === "none" ? "x".repeat(40_960) : current(file).after).length,
        change: changeOf(file), restorable: true, ...(file.restoredAt && !touched(file) ? { restoredAt: file.restoredAt } : {}),
      }));
    },
    /** 现在的内容（右边看全文用）：Word、Excel、老格式只给「别的」。 */
    content(path: string): string | null {
      const file = find(path);
      return file && !file.deleted && file.detail === "full" ? current(file).after : null;
    },
    read(path: string, range: FileChanges["range"]): FileChanges | null {
      const file = find(path);
      if (!file) return null;
      const revision = `${file.path}@${file.version}`;
      if (file.detail === "none") return { path, range, before: null, after: null, changes: [], revision, detail: "none" };
      if (file.deleted) return { path, range, before: file.start, after: null, changes: [{ id: "d1", before: { start: 0, end: file.start.length }, after: { start: 0, end: 0 } }], revision, detail: file.detail };
      const { after, changes } = current(file);
      return { path, range, before: file.start, after, changes, revision, detail: file.detail };
    },
    /** 恢复其中几处：文件又变了回 "changed"，Word、Excel 不能按处恢复回 "converted"。 */
    restoreChanges(path: string, ids: readonly string[], revision: string): "ok" | "changed" | "converted" | "missing" {
      const file = find(path);
      if (!file) return "missing";
      if (revision !== `${file.path}@${file.version}`) return "changed";
      if (file.detail !== "full") return "converted";
      if (file.deleted && ids.includes("d1")) file.deleted = false;
      file.edits = file.edits.filter((edit) => !ids.includes(edit.id));
      file.version += 1;
      if (!touched(file)) file.restoredAt = now();
      return "ok";
    },
    restoreFiles(paths?: readonly string[]): TLocalSessionRestoreResponse {
      const restored: string[] = [];
      const failed: TLocalRestoreFailure[] = [];
      for (const file of files.filter((entry) => !paths || paths.includes(entry.path))) {
        if (file.lockOnce) { file.lockOnce = false; failed.push({ path: file.path, reason: "in_use", message: "正被 Excel 打开，关掉再点" }); continue; }
        restoreAll(file);
        restored.push(file.path);
      }
      return { restored, failed };
    },
  };
}
