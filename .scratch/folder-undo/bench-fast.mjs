// 实测做法 1 的快版本：node bench-fast.mjs <文件夹> <影子 git 目录> [标签]
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FastShadow, scan } from "./fastsnap.mjs";

const [, , folder, gitDir, label = ""] = process.argv;
if (!folder.toLowerCase().includes("\\temp\\")) throw new Error("只测临时目录");
const du = (p) => { let n = 0; for (const e of readdirSync(p, { withFileTypes: true, recursive: true })) if (e.isFile()) n += statSync(join(e.parentPath, e.name)).size; return n; };
const sha = (p) => createHash("sha1").update(readFileSync(p)).digest("hex");
const time = async (fn) => { const t = performance.now(); const r = await fn(); return [Math.round(performance.now() - t), r]; };
const mb = (b) => Math.round(b / 1048576);
const diff = async (s, a, b) => {
  const parts = (await s.git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", a, b])).out.split("\0").filter(Boolean);
  const out = []; for (let i = 0; i < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] }); return out;
};

rmSync(gitDir, { recursive: true, force: true });
const s = new FastShadow(gitDir, folder, "f1");
const res = { label };
res.scanMs = (await time(() => scan(folder)))[0];
await s.init();
const [baseMs, base] = await time(() => s.fastSnapshot("base"));
Object.assign(res, { baselineMs: baseMs, sent: base.sent, skipped: base.skipped.length, bigSkipped: base.big.map((b) => `${b.rel} ${mb(b.size)}MB`), links: base.links });
res.gitDirMB = mb(du(gitDir));
const [noMs, t1] = await time(() => s.fastSnapshot("t1", base.commit));
res.noChangeSnapshotMs = noMs; res.noChangeSent = t1.sent;

// 执行方用命令动手：改 10 个、删 3 个、新建 5 个
const files = (await s.git(["ls-tree", "-r", "-z", "--name-only", base.commit])).out.split("\0").filter(Boolean);
const mod = files.slice(0, 10), del = files.slice(10, 13);
const before = Object.fromEntries([...mod, ...del].map((p) => [p, sha(join(folder, p))]));
await new Promise((r) => setTimeout(r, 50));
for (const p of mod) appendFileSync(join(folder, p), "\n执行方改了这里\n");
for (const p of del) unlinkSync(join(folder, p));
const created = [0, 1, 2, 3, 4].map((i) => `新建-${i}.md`);
for (const p of created) writeFileSync(join(folder, p), "新文件");
const [turnMs, t2] = await time(() => s.fastSnapshot("t2", t1.commit));
res.turnSnapshotMs = turnMs; res.turnSent = t2.sent; res.turnDeleted = t2.deleted;
const [dMs, ch] = await time(() => diff(s, base.commit, t2.commit));
res.diffMs = dMs; res.changes = { A: ch.filter((c) => c.status === "A").length, M: ch.filter((c) => c.status === "M").length, D: ch.filter((c) => c.status === "D").length };
res.gitDirAfterTurnMB = mb(du(gitDir));
// 单个恢复
res.restoreOneMs = (await time(() => s.restore(base.commit, mod[0])))[0];
await s.restore(base.commit, del[0]);
await s.restore(base.commit, created[0]);
res.restoreOneOk = sha(join(folder, mod[0])) === before[mod[0]] && sha(join(folder, del[0])) === before[del[0]] && !existsSync(join(folder, created[0]));
// 全部恢复（按 diff 的结果）
const t = performance.now();
const back = ch.filter((c) => c.status !== "A").map((c) => c.path);
await s.git(["checkout", base.commit, "--pathspec-from-file=-", "--pathspec-file-nul"], { input: back.join("\0") + "\0" });
for (const c of ch.filter((c) => c.status === "A")) rmSync(join(folder, c.path), { force: true });
res.restoreAllMs = Math.round(performance.now() - t);
res.restoreAllOk = [...mod, ...del].every((p) => existsSync(join(folder, p)) && sha(join(folder, p)) === before[p]) && created.every((p) => !existsSync(join(folder, p)));
console.log(JSON.stringify(res, null, 1));
