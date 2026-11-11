// 看得见改了什么、只动让动的那一块（设计第 72 条第一步，契约 LocalFileChangesResponse、LocalFileChangesRestoreRequest、事件 files_changed）。
// 真的临时文件夹、真的 git、假 Claude Code，不调模型。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalFileChangesResponse, LocalFileChangesRestoreResponse, LocalSessionEvent } from "@warmap/contracts";
import { UNDO_LIMITS, UndoStore, type SessionUndo, type TurnFile } from "../src/undo/index.js";
import { ChangesError, readChanges, restoreChanges, turnSummary } from "../src/undo/changes.js";
import { revertChanges, textChanges } from "../src/undo/textDiff.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}
const slices = (b: string, a: string) => textChanges(b, a).map((c) => [b.slice(c.before.start, c.before.end), a.slice(c.after.start, c.after.end)]);

describe("「一处」怎么切", () => {
  it("同一行里隔得远的两处是两处（中文按字）；挨得近的并成一处；换行原样、BOM 留着；只加、只删的行整段一处", () => {
    expect(slices("进展评估：良好。计划：完成联调和文档。\n", "进展评估：优秀。计划：完成联调、测试和文档。\n")).toEqual([["良好", "优秀"], ["", "、测试"]]);
    expect(slices("甲乙丙丁戊己\n", "甲子丙寅戊己\n")).toEqual([["乙丙丁", "子丙寅"]]); // 中间只隔一个字：并成一处
    expect(slices("甲乙丙丁戊己庚辛\n", "甲子丙丁戊己庚寅\n")).toEqual([["乙", "子"], ["辛", "寅"]]); // 隔了 5 个字：两处
    expect(slices("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\nd\r\n")).toEqual([["b", "B"], ["", "d\r\n"]]);
    expect(slices("The quick brown fox\n", "The quick red fox\n")).toEqual([["brown", "red"]]); // 英文按词
    expect(slices("第一段\n第三段\n", "第一段\n第二段\n第三段\n")).toEqual([["", "第二段\n"]]);
    expect(slices("﻿标题\n", "﻿标题改\n")).toEqual([["", "改"]]);
  });
  it("恢复其中一处：只这一处回去，别的不动", () => {
    const b = "进展评估：良好。计划：完成联调和文档。\n结尾\n";
    const a = "进展评估：优秀。计划：完成联调、测试和文档。\n结尾\n";
    const cs = textChanges(b, a);
    expect(revertChanges(b, a, cs, [cs[0]!.id])).toBe("进展评估：良好。计划：完成联调、测试和文档。\n结尾\n");
    expect(revertChanges(b, a, cs, cs.map((c) => c.id))).toBe(b);
  });
});

function store() {
  const turns: { turn: number; files: TurnFile[] }[] = [];
  const s = new UndoStore(tempDir("tl-chg-data-"), { isOwn: () => false, changed: () => {}, notice: () => {}, turnFiles: (_id, turn, files) => turns.push({ turn, files }) });
  return { s, turns };
}
async function ready(u: SessionUndo) {
  u.open();
  await until(() => u.view().state !== "preparing");
  expect(u.view().state).toBe("ready");
  return u;
}
async function turn(u: SessionUndo, fn: () => void) {
  u.onEvent("agent_info");
  await u.beforeWrite("Bash", { command: "x" }, ".");
  fn();
  u.onEvent("turn_end");
  await u.files();
}

describe("读改动、按处恢复（快照这一路）", { timeout: 60_000 }, () => {
  it("同一行里两处，恢复其中一处、另一处还在，内容逐字节对；读了以后文件又变了，恢复被拒（file_changed）", async () => {
    const dir = tempDir("tl-chg-");
    const doc = join(dir, "周报.md");
    writeFileSync(doc, "# 周报\r\n进展评估：良好。计划：完成联调和文档。\r\n");
    const { s, turns } = store();
    const u = await ready(s.for("c1", dir));
    await turn(u, () => writeFileSync(doc, "# 周报\r\n进展评估：优秀。计划：完成联调、测试和文档。\r\n"));
    // 一轮结束的事件：周报.md · 2 处
    expect(turns).toHaveLength(1);
    expect(await turnSummary(u, turns[0]!.turn, turns[0]!.files)).toEqual({ files: [{ path: "周报.md", absolutePath: doc, change: "modified", detail: "full", count: 2 }], more: 0 });
    const r = await readChanges(u, "周报.md", "turn");
    expect(Value.Check(LocalFileChangesResponse, r.file)).toBe(true);
    expect(r.file).toMatchObject({ range: "turn", turn: 1, change: "modified", detail: "full", restorable: true });
    expect(r.file.changes!.map((c) => r.file.after!.slice(c.after.start, c.after.end))).toEqual(["优秀", "、测试"]);
    const out = await restoreChanges(u, "周报.md", "turn", undefined, [r.file.changes![0]!.id], r.file.revision);
    expect(Value.Check(LocalFileChangesRestoreResponse, out)).toBe(true);
    expect(readFileSync(doc)).toEqual(Buffer.from("# 周报\r\n进展评估：良好。计划：完成联调、测试和文档。\r\n"));
    expect(out.file.changes!.map((c) => out.file.after!.slice(c.after.start, c.after.end))).toEqual(["、测试"]); // 剩下那一处还在
    // 读了以后本人又改了：拒绝，让网页重读
    const again = await readChanges(u, "周报.md", "turn");
    writeFileSync(doc, readFileSync(doc, "utf8") + "本人加的\r\n");
    await expect(restoreChanges(u, "周报.md", "turn", undefined, [again.file.changes![0]!.id], again.file.revision)).rejects.toMatchObject({ code: "file_changed" });
    expect(readFileSync(doc, "utf8")).toContain("本人加的");
    await expect(restoreChanges(u, "周报.md", "turn", undefined, ["不认识"], (await readChanges(u, "周报.md", "turn")).file.revision)).rejects.toMatchObject({ code: "validation" });
  });

  it("带 BOM 的文件（Windows 记事本存的）：区间对得上，按处恢复后 BOM 还在", async () => {
    const dir = tempDir("tl-chg-bom-");
    const doc = join(dir, "记事本.txt");
    writeFileSync(doc, "﻿甲：良好\r\n乙：一般\r\n");
    const { s } = store();
    const u = await ready(s.for("c5", dir));
    await turn(u, () => writeFileSync(doc, "﻿甲：优秀\r\n乙：很好\r\n"));
    const r = (await readChanges(u, "记事本.txt", "turn")).file;
    expect(r.changes!.map((c) => r.after!.slice(c.after.start, c.after.end))).toEqual(["优秀", "很好"]);
    await restoreChanges(u, "记事本.txt", "turn", undefined, [r.changes![1]!.id], r.revision);
    expect(readFileSync(doc)).toEqual(Buffer.from("﻿甲：优秀\r\n乙：一般\r\n"));
  });

  it("超过 1MB、二进制（Word、Excel）只说改过：detail none、处数 null、不给全文、不能按处恢复；新建的整份一处、只能整个恢复", async () => {
    const dir = tempDir("tl-chg-big-");
    writeFileSync(join(dir, "大.md"), "a\n".repeat(600_000));
    writeFileSync(join(dir, "表.xlsx"), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 1]));
    const { s, turns } = store();
    const u = await ready(s.for("c2", dir));
    await turn(u, () => {
      writeFileSync(join(dir, "大.md"), "b\n".repeat(600_000));
      writeFileSync(join(dir, "表.xlsx"), Buffer.from([0x50, 0x4b, 3, 4, 9, 9, 9]));
      writeFileSync(join(dir, "新建.md"), "第一行\n第二行\n");
    });
    const sum = await turnSummary(u, turns[0]!.turn, turns[0]!.files);
    expect(sum.files).toEqual([
      { path: "大.md", absolutePath: join(dir, "大.md"), change: "modified", detail: "none", count: null },
      { path: "新建.md", absolutePath: join(dir, "新建.md"), change: "added", detail: "full", count: 1 },
      { path: "表.xlsx", absolutePath: join(dir, "表.xlsx"), change: "modified", detail: "none", count: null },
    ]);
    for (const p of ["大.md", "表.xlsx"]) {
      const r = await readChanges(u, p, "turn");
      expect(r.file).toMatchObject({ detail: "none", restorable: false });
      expect(r.file.before).toBeUndefined();
      expect(r.file.changes).toBeUndefined();
      await expect(restoreChanges(u, p, "turn", undefined, ["x"], r.file.revision)).rejects.toMatchObject({ code: "validation" });
    }
    const n = await readChanges(u, "新建.md", "turn");
    expect(n.file).toMatchObject({ change: "added", detail: "full", before: null, after: "第一行\n第二行\n", restorable: false, changes: [{ before: { start: 0, end: 0 }, after: { start: 0, end: 8 } }] });
    // 这一轮没改过的文件：404
    await expect(readChanges(u, "没有.md", "turn")).rejects.toBeInstanceOf(ChangesError);
  });

  it("这一轮 / 开工到现在：两轮改同一个文件，turn 给轮号看那一轮（更早的一轮不能按处恢复），session 从会话第一次动它之前比到现在", async () => {
    const dir = tempDir("tl-chg-range-");
    const doc = join(dir, "a.md");
    writeFileSync(doc, "一\n二\n三\n");
    const { s } = store();
    const u = await ready(s.for("c3", dir));
    await turn(u, () => writeFileSync(doc, "一改\n二\n三\n"));
    await turn(u, () => writeFileSync(doc, "一改\n二\n三改\n"));
    const t1 = (await readChanges(u, "a.md", "turn", 1)).file;
    expect([t1.turn, t1.before, t1.after, t1.restorable]).toEqual([1, "一\n二\n三\n", "一改\n二\n三\n", false]);
    const t2 = (await readChanges(u, "a.md", "turn")).file;
    expect([t2.turn, t2.before, t2.after, t2.restorable]).toEqual([2, "一改\n二\n三\n", "一改\n二\n三改\n", true]);
    const all = (await readChanges(u, "a.md", "session")).file;
    expect([all.turn, all.before, all.after, all.changes!.length]).toEqual([null, "一\n二\n三\n", "一改\n二\n三改\n", 2]);
  });

  it("只改前拷一份的文件夹：改文件工具改的照样有改前那份（第二轮再改也看得到那一轮的）；命令改的拿不到", async () => {
    UNDO_LIMITS.files = 0;
    try {
      const dir = tempDir("tl-chg-touched-");
      const doc = join(dir, "a.md");
      writeFileSync(doc, "原文\n");
      writeFileSync(join(dir, "b.md"), "原文\n");
      const { s, turns } = store();
      const u = s.for("c4", dir);
      u.open();
      await until(() => u.view().state === "touched_only");
      u.onEvent("agent_info");
      await u.beforeWrite("Edit", { file_path: doc }, dir);
      writeFileSync(doc, "第一轮\n");
      writeFileSync(join(dir, "b.md"), "命令改的\n");
      u.onEvent("turn_end");
      await u.files();
      u.onEvent("agent_info");
      await u.beforeWrite("Edit", { file_path: doc }, dir);
      writeFileSync(doc, "第二轮\n");
      u.onEvent("turn_end");
      await u.files();
      expect(turns.map((t) => [t.turn, t.files.map((f) => f.path)])).toEqual([[1, ["a.md"]], [2, ["a.md"]]]);
      expect((await readChanges(u, "a.md", "turn")).file).toMatchObject({ turn: 2, before: "第一轮\n", after: "第二轮\n", restorable: true });
      expect((await readChanges(u, "a.md", "session")).file).toMatchObject({ before: "原文\n", after: "第二轮\n" });
      await expect(readChanges(u, "b.md", "session")).rejects.toMatchObject({ code: "not_found" });
    } finally {
      UNDO_LIMITS.files = 30_000;
    }
  });
});

describe("经本机 API", { timeout: 60_000 }, () => {
  it("一轮结束记 files_changed；读改动、按处恢复；一轮在跑回 409；file_changed 回 409；卡在工作树里只能看开工到现在", async () => {
    const work = tempDir("tl-chg-api-");
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const t = await startTestRunner({ pickFolder: work, fetchImpl: offline });
    try {
      const token = await pair(t.port);
      const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
      await call("POST", "/v1/folders/pick", {});
      const dir = join(work, "A");
      mkdirSync(dir);
      writeFileSync(join(work, ".fake-claude.json"), JSON.stringify({ initDelayMs: 1500 }));
      const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "A" }, title: "A", cwd: dir, firstMessage: "做", permissionMode: "auto" });
      const id = r.body.id;
      const events = () => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const ev = await until(() => events().find((e) => e.type === "files_changed"));
      expect(Value.Check(LocalSessionEvent, ev)).toBe(true);
      expect(ev).toMatchObject({ turn: 1, more: 0, files: [{ path: "hello.txt", change: "added", detail: "full", count: 1 }] });
      const read = await call("POST", `/v1/sessions/${id}/files/changes`, { path: "hello.txt" });
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body).toMatchObject({ change: "added", before: null, after: "你好", restorable: false });
      // revision 对不上：409 file_changed，网页重读
      const stale = await call("POST", `/v1/sessions/${id}/files/changes/restore`, { path: "hello.txt", ids: ["x"], revision: "0".repeat(40) });
      expect([stale.status, stale.body.error?.code]).toEqual([409, "file_changed"]);
      expect((await call("POST", `/v1/sessions/${id}/files/changes`, { path: "没有.txt" })).status).toBe(404);
      // 一轮在跑（等批准）时不让按处恢复
      const b = join(work, "B");
      mkdirSync(b);
      const busy = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "B" }, title: "B", cwd: b, firstMessage: "做", permissionMode: "default" });
      await until(async () => (await call("GET", `/v1/sessions/${busy.body.id}`)).body.session.status === "waiting_permission");
      expect((await call("POST", `/v1/sessions/${busy.body.id}/files/changes/restore`, { path: "hello.txt", ids: ["x"], revision: null })).status).toBe(409);
      // 卡在工作树里：只能看开工到现在
      const repo = join(work, "R");
      mkdirSync(repo);
      writeFileSync(join(repo, "readme.md"), "原来\n");
      const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=测试", "-c", "user.email=test@example.com", ...args], { cwd: repo, stdio: "pipe" });
      g("init", "-q", "-b", "main");
      g("add", "-A");
      g("commit", "-q", "-m", "init");
      const w = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: "R" }, title: "R", cwd: repo, firstMessage: "做", permissionMode: "auto" });
      await until(async () => (await call("GET", `/v1/sessions/${w.body.id}`)).body.session.status === "idle");
      const tree = w.body.workspace.path as string;
      writeFileSync(join(tree, "readme.md"), "原来\n加了一行\n");
      const ws = await call("POST", `/v1/sessions/${w.body.id}/files/changes`, { path: "readme.md", range: "session" });
      expect(ws.status, JSON.stringify(ws.body)).toBe(200);
      expect(ws.body).toMatchObject({ range: "session", before: "原来\n", after: "原来\n加了一行\n", restorable: false, changes: [{ after: { start: 3, end: 8 } }] });
      expect((await call("POST", `/v1/sessions/${w.body.id}/files/changes`, { path: "readme.md" })).status).toBe(400);
    } finally {
      await t.cleanup();
    }
  });
});
