// Windows 上的麻烦情况：路径超长、文件被占用（像 Excel）、嵌套的 .git、文件夹里的 .gitignore、读不了的文件、目录联接（junction）指到外面、
// 一个 1GB 的大文件、影子仓库写不进去。用法：node edge.mjs <临时目录>
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Shadow } from "./shadow.mjs";

const root = process.argv[2];
if (!root?.toLowerCase().includes("\\temp\\")) throw new Error("只在临时目录");
rmSync(root, { recursive: true, force: true });
const work = join(root, "文件夹"), outside = join(root, "外面"), gitDir = join(root, "shadow.git");
mkdirSync(work, { recursive: true }); mkdirSync(outside, { recursive: true });
const out = {};
const t = async (fn) => { const s = performance.now(); try { const r = await fn(); return { ms: Math.round(performance.now() - s), ok: true, r }; } catch (e) { return { ms: Math.round(performance.now() - s), ok: false, err: String(e.message).slice(0, 300) }; } };

// 1. 路径超长（> 260）
let deep = work;
for (let i = 0; i < 12; i++) deep = join(deep, `很长的中文目录名字第${i}层_abcdefghij`);
mkdirSync(deep, { recursive: true });
const longFile = join(deep, "长路径里的报告.md");
writeFileSync(longFile, "长路径原文\n");
out.longPathLength = longFile.length;
// 2. 被占用的文件：一个像 Excel（别人能读、不能写），一个独占（谁都不能读写）
const shareRead = join(work, "开着的表格.xlsx"), shareNone = join(work, "独占的文件.xlsx");
writeFileSync(shareRead, randomBytes(50_000)); writeFileSync(shareNone, randomBytes(50_000));
// 3. 文件夹里套着一个 git 仓库
const sub = join(work, "子仓库"); mkdirSync(sub);
writeFileSync(join(sub, "子仓库里的文件.md"), "子仓库原文\n");
execFileSync("git", ["init", "-q"], { cwd: sub });
// 4. 文件夹里自己的 .gitignore
writeFileSync(join(work, ".gitignore"), "*.log\n");
writeFileSync(join(work, "运行记录.log"), "日志原文\n");
// 5. 读不了的文件（本人自己的 ACL 拒绝读）
const noRead = join(work, "读不了.md"); writeFileSync(noRead, "读不了原文\n");
execFileSync("icacls", [noRead, "/deny", `${process.env.USERNAME}:(R)`], { stdio: "ignore" });
// 6. 目录联接指到外面
writeFileSync(join(outside, "外面的文件.md"), "外面原文\n");
execFileSync("cmd", ["/c", "mklink", "/J", join(work, "联接到外面"), outside], { stdio: "ignore" });

// 占住两个文件（PowerShell 开着不关）
const hold = (file, share) => spawn("powershell", ["-NoProfile", "-Command", `$f=[System.IO.File]::Open('${file}','Open','ReadWrite','${share}'); Start-Sleep 60`], { stdio: "ignore" });
const h1 = hold(shareRead, "Read"), h2 = hold(shareNone, "None");
await new Promise((r) => setTimeout(r, 2500));

const s = new Shadow(gitDir, work, "e");
await s.init();
const base = await t(() => s.snapshot("base"));
out.baseline = { ms: base.ms, ok: base.ok, err: base.err, addCode: s.lastAddCode, addErr: s.lastAddErr?.split("\n").filter(Boolean).slice(0, 8) };
const files = (await s.git(["ls-files", "-z"])).out.split("\0").filter(Boolean);
out.inSnapshot = {
  longPath: files.some((f) => f.endsWith("长路径里的报告.md")),
  excelLike: files.includes("开着的表格.xlsx"), exclusive: files.includes("独占的文件.xlsx"),
  nestedRepoFile: files.some((f) => f.includes("子仓库里的文件")), nestedRepoEntry: files.filter((f) => f.startsWith("子仓库")),
  gitignored: files.includes("运行记录.log"), noRead: files.includes("读不了.md"),
  junctionFollowed: files.some((f) => f.startsWith("联接到外面")), total: files.length,
};
// 做法 2 在占用的文件上：拷一份
out.copyExcelLike = await t(() => copyFileSync(shareRead, join(root, "copy1.xlsx")));
out.copyExclusive = await t(() => copyFileSync(shareNone, join(root, "copy2.xlsx")));
// 执行方能不能改占用的文件（它改不了，我们也就不用留）
out.agentWriteExcelLike = await t(() => appendFileSync(shareRead, "x"));
// 改长路径文件后恢复
appendFileSync(longFile, "执行方改了\n");
const rl = await t(() => s.restore(base.r, files.find((f) => f.endsWith("长路径里的报告.md"))));
out.restoreLongPath = { ...rl, back: readFileSync(longFile, "utf8") === "长路径原文\n" };
// 占用着的时候恢复（像 Excel 开着那张表时点恢复）：先在快照里留一份内容不同的
h1.kill(); await new Promise((r) => setTimeout(r, 1500));
const v1 = readFileSync(shareRead);
appendFileSync(shareRead, "执行方改了");
const h3 = hold(shareRead, "Read"); await new Promise((r) => setTimeout(r, 2500));
const rr = await t(() => s.restore(base.r, "开着的表格.xlsx"));
out.restoreWhileOpen = { ok: rr.ok, err: rr.err, back: Buffer.compare(readFileSync(shareRead), v1) === 0 };
h3.kill(); h2.kill(); await new Promise((r) => setTimeout(r, 1500));
const rr2 = await t(() => s.restore(base.r, "开着的表格.xlsx"));
out.restoreAfterClose = { ok: rr2.ok, back: Buffer.compare(readFileSync(shareRead), v1) === 0 };

// 7. 一个 1GB 的大文件：git 留一份 vs 直接拷一份
const bigFile = join(work, "大视频.mp4");
const chunk = randomBytes(8 << 20); for (let i = 0; i < 128; i++) appendFileSync(bigFile, chunk);
out.big1GB_gitAdd = (await t(() => s.snapshot("big", base.r))).ms;
out.big1GB_copyFile = (await t(() => copyFileSync(bigFile, join(root, "big-copy.mp4")))).ms;
unlinkSync(join(root, "big-copy.mp4"));

// 8. 影子仓库写不进去（模拟盘满、没权限）：objects 目录拒绝写
writeFileSync(join(work, "又一个新文件.md"), "新\n");
execFileSync("icacls", [join(gitDir, "objects"), "/deny", `${process.env.USERNAME}:(W,AD)`, "/T"], { stdio: "ignore" });
const fail = await t(() => s.snapshot("fail", base.r));
out.snapshotWhenUnwritable = { ok: fail.ok, ms: fail.ms, err: fail.err?.slice(0, 200) };
execFileSync("icacls", [join(gitDir, "objects"), "/remove:d", process.env.USERNAME, "/T"], { stdio: "ignore" });
execFileSync("icacls", [noRead, "/remove:d", process.env.USERNAME], { stdio: "ignore" });
console.log(JSON.stringify(out, null, 1));
