// git add 直接写包：core.bigFileThreshold 很小 → 每个文件走 bulk-checkin，一次 add 只出一个包；core.fscache 用批量目录读取。
import { rmSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Shadow } from "./shadow.mjs";
const [, , folder, gitDir, extra = ""] = process.argv;
rmSync(gitDir, { recursive: true, force: true });
const s = new Shadow(gitDir, folder, "b");
s.extraExcludes = ["/录像.mp4"];
await s.init();
const cfg = ["-c", "core.bigFileThreshold=1", "-c", "core.fscache=true", "-c", "core.compression=1", ...(extra ? ["-c", extra] : [])];
const t = async (label, fn) => { const a = performance.now(); const r = await fn(); console.log(label, Math.round(performance.now() - a), "ms"); return r; };
const snap = async (name, parent) => {
  const r = await s.git([...cfg, "add", "-A", "--ignore-errors", "--", "."], { allowFail: true });
  if (r.code) console.log("add err", r.err.slice(0, 200));
  const tree = (await s.git(["write-tree"])).out.trim();
  const c = (await s.git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", name])).out.trim();
  await s.git(["update-ref", `refs/tianshu/b/${name}`, c]);
  return c;
};
const base = await t("baseline", () => snap("base"));
let n = 0, b = 0; for (const e of readdirSync(gitDir, { withFileTypes: true, recursive: true })) if (e.isFile()) { n++; b += statSync(join(e.parentPath, e.name)).size; }
console.log("gitDir files", n, "MB", Math.round(b / 1048576));
await t("no-change snapshot", () => snap("t1", base));
const files = (await s.git(["ls-files", "-z"])).out.split("\0").filter(Boolean);
for (const p of files.slice(0, 10)) appendFileSync(join(folder, p), "\n再改一次\n");
const t2 = await t("turn snapshot (10 changed)", () => snap("t2", base));
await t("diff", () => s.git(["diff-tree", "-r", "-z", "--name-status", base, t2]));
await t("restore 10 to base", () => s.git(["checkout", base, "--", ...files.slice(0, 10)]));
