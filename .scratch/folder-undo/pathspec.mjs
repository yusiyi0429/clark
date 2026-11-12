// 推荐写法的细节：git add -A -f（.gitignore 里的照样留）+ 排除规则从文件读（node_modules、联接、大文件不进）+ 直接写包 + fscache。
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Shadow } from "./shadow.mjs";
import { scan } from "./fastsnap.mjs";
const [, , folder, gitDir] = process.argv;
rmSync(gitDir, { recursive: true, force: true });
mkdirSync(join(folder, "tool", "node_modules", "x"), { recursive: true });
writeFileSync(join(folder, "tool", "node_modules", "x", "a.js"), "x");
const s = new Shadow(gitDir, folder, "p");
await s.init();
writeFileSync(join(gitDir, "info", "exclude"), ""); // 不靠 info/exclude，排除全写成 pathspec
const sc = scan(folder);
const rel = (p) => p.slice(folder.length + 1).split("\\").join("/");
const excludes = [":(exclude,glob)**/node_modules/**", ":(exclude,glob)**/.git/**", ...sc.links.map((p) => `:(exclude,literal)${rel(p)}`), ...sc.big.map((b) => `:(exclude,literal)${b.rel}`)];
const t = performance.now();
const r = await s.git(["-c", "core.bigFileThreshold=1", "-c", "core.fscache=true", "-c", "core.compression=1", "add", "-A", "-f", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: [".", ...excludes].join("\0") + "\0", allowFail: true });
const ms = Math.round(performance.now() - t);
const files = (await s.git(["ls-files", "-z"])).out.split("\0").filter(Boolean);
console.log(JSON.stringify({ ms, code: r.code, err: r.err.split("\n").filter(Boolean).slice(0, 6), links: sc.links.length, big: sc.big.map((b) => b.rel), total: files.length,
  gitignoredKept: files.includes("运行记录.log"), junctionSkipped: !files.some((f) => f.startsWith("联接到外面")), nodeModulesSkipped: !files.some((f) => f.includes("node_modules")),
  bigSkipped: !files.includes("大视频.mp4"), longPath: files.some((f) => f.endsWith("长路径里的报告.md")), nested: files.filter((f) => f.startsWith("子仓库")) }, null, 1));
