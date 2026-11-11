/**
 * 假本机里「执行方改了文件」的那部分（设计第 71、72 条，契约 LocalFileChangesResponse、files_changed）：不在工作树里做的会话，
 * 第一轮改周报（两处，一处是顺手把「良好」改成「优秀」）；本人再说一句，第二轮删一个旧文件、新建一份交接清单、
 * 改一份 Word 和一份 Excel（转成 Markdown 的明细，只能看）、动一个老格式的表（只知道改过）。
 * 只照位置造数据，不比文本：每处改动记成「把第 n 个 find 换成 replace」，恢复一处就是去掉那一条再算一遍。
 * 报表.xlsx 第一次整个恢复时报「正被 Excel 打开」，再点一次才成（演「文件被占用」）。
 */
import type { TLocalChangedFile, TLocalRestoreFailure, TLocalSessionRestoreResponse } from "@warmap/contracts";
import type { ChangeRange, FileChange, FileChanges, TurnFile } from "./fileChanges";
import { REPORT, edited } from "./fileChanges.fixture";

type Edit = { id: string; find: string; replace: string; nth?: number };
type MockFile = {
  path: string;
  /** 会话把它怎么了（恢复以后照旧写原来那样）。 */
  action: TurnFile["change"];
  detail: FileChanges["detail"];
  /** 会话动它之前的内容（Word、Excel 是转出来的 Markdown；新建的是新建出来的内容）。 */
  start: string;
  /** 还没恢复的改动。 */
  edits: Edit[];
  /** 现在磁盘上没有（删掉了没恢复、新建的恢复了）。 */
  gone: boolean;
  restoredAt?: string;
  /** 整个恢复时先报一次「被占用」。 */
  lockOnce?: boolean;
  version: number;
  /** 第几轮动的。 */
  turn: number;
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
const HANDOVER = ["# 交接清单", "", "- 接手人：林知行", "- 交接日期：11 月 18 日", "- 要带走的：周报、合同、报表", ""].join("\n");

type Seed = Omit<MockFile, "gone" | "version" | "turn">;
const SEEDS: Seed[] = [
  { path: "周报.md", action: "modified", detail: "full", start: REPORT,
    edits: [{ id: "c1", find: "11 月 13 日（周五）", replace: "11 月 18 日（周三）" }, { id: "c2", find: "良好", replace: "优秀", nth: 1 }] },
  { path: "旧安排.md", action: "deleted", detail: "full", start: "# 旧安排\n\n上线定在 11 月 13 日（周五）。\n", edits: [] },
  { path: "交接清单.md", action: "added", detail: "full", start: HANDOVER, edits: [] },
  { path: "合同.docx", action: "modified", detail: "converted", start: CONTRACT, edits: [{ id: "w1", find: "30 天", replace: "45 天" }] },
  { path: "报表.xlsx", action: "modified", detail: "converted", start: SHEET, lockOnce: true,
    edits: [{ id: "x1", find: "135", replace: "138" }, { id: "x2", find: "=SUM(B9:M9)", replace: "=SUM(B9:L9)" }, { id: "x3", find: "万元", replace: "元" }] },
  { path: "预算.xls", action: "modified", detail: "none", start: "", edits: [] },
];

/**
 * 分两轮演：第一轮只改周报（验收第 10 条：「周报.md 2 处」）；
 * 本人再说一句，第二轮删旧安排.md、新建交接清单.md、改 Word、Excel 和老格式的表（验收第 9 条，收成「改了 5 个文件」）。
 */
const ROUNDS = [["周报.md"], ["旧安排.md", "交接清单.md", "合同.docx", "报表.xlsx", "预算.xls"]];

const now = () => new Date().toISOString();

/** 一个会话的改动（假的）。root：会话根（拼 absolutePath）。 */
export function createMockEdits(root: string) {
  let files: MockFile[] = [];
  let round = 0;
  const find = (path: string) => files.find((file) => file.path === path || `${root}/${file.path}` === path) ?? null;
  /** 现在的样子：没恢复的改动照位置算出来，id 换回各自的。 */
  const current = (file: MockFile): { after: string; changes: FileChange[] } => {
    const made = edited(file.start, file.edits.map((edit) => [edit.find, edit.replace, edit.nth]));
    return { after: made.after, changes: made.changes.map((change) => ({ ...change, id: file.edits[Number(change.id.slice(1)) - 1]!.id })) };
  };
  /** 还算改动着（没恢复）：删掉的还没回来、新建的还在、还有没恢复的几处。 */
  const touched = (file: MockFile) => (file.action === "modified" ? file.edits.length > 0 : file.action === "deleted" ? file.gone : !file.gone);
  const revisionOf = (file: MockFile) => (file.gone ? null : `${file.path}@${file.version}`);
  const turnFile = (file: MockFile): TurnFile => ({
    path: file.path, absolutePath: `${root}/${file.path}`, change: file.action, detail: file.detail,
    count: file.detail === "none" ? null : file.action === "modified" ? file.edits.length : 1,
  });

  return {
    /** 执行方下一轮动手，回这一轮改了哪些（files_changed 的 turn、files）；两轮都演完了回空。 */
    apply(): { turn: number; files: TurnFile[] } {
      const batch = SEEDS.filter((seed) => ROUNDS[round]?.includes(seed.path)).map((seed): MockFile => ({ ...seed, edits: [...seed.edits], gone: seed.action === "deleted", version: 1, turn: round + 1 }));
      round += 1;
      files = [...files, ...batch];
      return { turn: round, files: batch.map(turnFile) };
    },
    /** 还有没演的一轮。 */
    pending: () => round < ROUNDS.length,
    has: (path: string) => !!find(path),
    /** 右栏「改动的文件」：都有留一份、都能恢复。 */
    list(): TLocalChangedFile[] {
      return files.map((file) => ({
        path: file.path, absolutePath: `${root}/${file.path}`, sources: ["snapshot"], exists: !file.gone,
        size: file.gone ? null : file.detail === "none" ? 40_960 : new TextEncoder().encode(current(file).after).length,
        change: file.action, restorable: true, ...(file.restoredAt && !touched(file) ? { restoredAt: file.restoredAt } : {}),
      }));
    },
    /** 现在的内容（右边看全文用）：Word、Excel、老格式只给「别的」，不在了的为 null。 */
    content(path: string): string | null {
      const file = find(path);
      return file && !file.gone && file.detail === "full" ? current(file).after : null;
    },
    /** 读改动（假的不分轮：那一轮和开工到现在一样）。 */
    read(path: string, range: ChangeRange, turn?: number): FileChanges | null {
      const file = find(path);
      if (!file) return null;
      const base = { path: file.path, absolutePath: `${root}/${file.path}`, range, turn: range === "turn" ? turn ?? file.turn : null, change: file.action, detail: file.detail, revision: revisionOf(file) };
      if (file.detail === "none") return { ...base, restorable: false };
      if (!touched(file)) {
        // 恢复过了：改前改后一样，没有改动；新建的恢复以后不在了。
        const text = file.gone ? null : current(file).after;
        return { ...base, before: text, after: text, changes: [], restorable: false };
      }
      if (file.action === "deleted") return { ...base, before: file.start, after: null, changes: [{ id: "d1", before: { start: 0, end: file.start.length }, after: { start: 0, end: 0 } }], restorable: false };
      if (file.action === "added") return { ...base, before: null, after: file.start, changes: [{ id: "a1", before: { start: 0, end: 0 }, after: { start: 0, end: file.start.length } }], restorable: false };
      const { after, changes } = current(file);
      return { ...base, before: file.start, after, changes, restorable: file.detail === "full" };
    },
    /** 恢复其中几处：文件又变了回 "changed"，不能按处恢复（Word、Excel、整份新建或删掉的）回 "whole_only"。 */
    restoreChanges(path: string, ids: readonly string[], revision: string | null): "ok" | "changed" | "whole_only" | "missing" {
      const file = find(path);
      if (!file) return "missing";
      if (revision !== revisionOf(file)) return "changed";
      if (file.detail !== "full" || file.action !== "modified") return "whole_only";
      file.edits = file.edits.filter((edit) => !ids.includes(edit.id));
      file.version += 1;
      if (!touched(file)) file.restoredAt = now();
      return "ok";
    },
    /** 整个恢复：改了的回到原样、删掉的回来、新建的删掉。 */
    restoreFiles(paths?: readonly string[]): TLocalSessionRestoreResponse {
      const restored: string[] = [];
      const failed: TLocalRestoreFailure[] = [];
      for (const file of files.filter((entry) => !paths || paths.some((path) => path === entry.path || path === `${root}/${entry.path}`))) {
        if (file.lockOnce) { file.lockOnce = false; failed.push({ path: file.path, reason: "in_use", message: "正被 Excel 打开，关掉再点" }); continue; }
        file.edits = [];
        file.gone = file.action === "added";
        file.restoredAt = now();
        file.version += 1;
        restored.push(file.path);
      }
      return { restored, failed };
    },
  };
}
