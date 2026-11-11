// 实测做法 1：node bench.mjs <文件夹> <影子 git 目录> [标签]
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Shadow } from "./shadow.mjs";

const [, , folder, gitDir, label = ""] = process.argv;
if (!folder.toLowerCase().includes("\\temp\\")) throw new Error("只测临时目录");
const du = (p) => { let n = 0, f = 0; for (const e of readdirSync(p, { withFileTypes: true, recursive: true })) if (e.isFile()) { n += statSync(join(e.parentPath, e.name)).size; f++; } return { bytes: n, files: f }; };
const sha = (p) => createHash("sha1").update(readFileSync(p)).digest("hex");
const time = async (fn) => { const t = performance.now(); const r = await fn(); return [Math.round(performance.now() - t), r]; };
const mb = (b) => Math.round(b / 1048576);

rmSync(gitDir, { recursive: true, force: true });
const s = new Shadow(gitDir, folder, "s1");
const src = du(folder);
const res = { label, folder: { files: src.files, MB: mb(src.bytes) } };
res.initMs = (await time(() => s.init()))[0];
const [baseMs, base] = await time(() => s.snapshot("base"));
res.baselineMs = baseMs; res.addErr = s.lastAddErr?.slice(0, 300);
res.gitDirAfterBase = mb(du(gitDir).bytes);
res.tracked = Number((await s.git(["ls-files", "-z"])).out.split("\0").filter(Boolean).length);
res.noChangeSnapshotMs = (await time(() => s.snapshot("t1", base)))[0];

// 执行方动手：改 10 个、删 3 个、新建 5 个
const files = (await s.git(["ls-files", "-z"])).out.split("\0").filter(Boolean).filter((p) => !p.endsWith(".mp4"));
const mod = files.slice(0, 10), del = files.slice(10, 13);
const before = Object.fromEntries([...mod, ...del].map((p) => [p, sha(join(folder, p))]));
for (const p of mod) appendFileSync(join(folder, p), "\n执行方改了这里\n");
for (const p of del) unlinkSync(join(folder, p));
const created = [0, 1, 2, 3, 4].map((i) => `新建-${i}.md`);
for (const p of created) writeFileSync(join(folder, p), "新文件");
res.turnSnapshotMs = (await time(() => s.snapshot("t2", base)))[0];
const [chMs, ch] = await time(() => s.changes(base));
res.changesMs = chMs; res.changes = { A: ch.filter((c) => c.status === "A").length, M: ch.filter((c) => c.status === "M").length, D: ch.filter((c) => c.status === "D").length };
res.gitDirAfterTurn = mb(du(gitDir).bytes);

// 单个恢复：改了的、删了的、新建的
res.restoreOneMs = (await time(() => s.restore(base, mod[0])))[0];
await s.restore(base, del[0]);
await s.restore(base, created[0]);
res.restoreOneOk = sha(join(folder, mod[0])) === before[mod[0]] && sha(join(folder, del[0])) === before[del[0]] && !existsSync(join(folder, created[0]));
// 全部恢复
const [allMs, all] = await time(() => s.restoreAll(base));
res.restoreAllMs = allMs; res.restoreAllFailed = all.failed;
res.restoreAllOk = [...mod, ...del].every((p) => existsSync(join(folder, p)) && sha(join(folder, p)) === before[p]) && created.every((p) => !existsSync(join(folder, p)));
res.changesAfterRestore = (await s.changes(base)).length;
console.log(JSON.stringify(res, null, 1));
