// 生成 C妹 的预览页 ../preview.html：从 Miles 所在的分支取 milesRig.ts 和 milesArt.ts，打上 ../milesRig-iris-gaze.patch，
// 用 TypeScript 转成浏览器直接能跑的 JS，和 ../cmeiArt.ts 一起塞进 preview.src.html。页面自带全部代码和画，双击就能打开。
//
// 用法：node .scratch/buddy-cmei/tools/build-preview.cjs [--ref <git 引用>] [--artifact <输出路径>]
//   --ref       Miles 所在的提交，默认 origin/claude/handover-new-phase-review-c26739；Miles 合进 main 以后改成 origin/main。
//               先 git fetch 一下这个分支。
//   --artifact  另写一份不带 <html>/<head> 外壳的页面，给 Artifact 发布用（发布时会自动套外壳）。
// 依赖：git、TypeScript（require("typescript")；没有的话在仓库根目录 pnpm install）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const ROOT = path.join(HERE, "..");
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const ref = arg("--ref", "origin/claude/handover-new-phase-review-c26739");
const RIG = "apps/web/src/components/coagent/milesRig.ts";
const ART = "apps/web/src/components/coagent/milesArt.ts";
const show = (file) => execFileSync("git", ["show", `${ref}:${file}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
const rigTs = show(RIG);
const milesTs = show(ART);

// 打补丁：在临时目录里按仓库路径放好 milesRig.ts，用 git apply（不在仓库里时它就是一个更严格的 patch）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmei-rig-"));
let patched;
try {
  fs.mkdirSync(path.join(tmp, path.dirname(RIG)), { recursive: true });
  fs.writeFileSync(path.join(tmp, RIG), rigTs);
  execFileSync("git", ["apply", path.join(ROOT, "milesRig-iris-gaze.patch")], { cwd: tmp, stdio: "inherit" });
  patched = fs.readFileSync(path.join(tmp, RIG), "utf8");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

let ts;
try { ts = require("typescript"); } catch { throw new Error("找不到 TypeScript：在仓库根目录 pnpm install，或者全局装一个 typescript"); }
const js = ts.transpileModule(patched, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
// 去掉 import（画改成参数传进来）和 export，包成工厂：一份动作代码能挂不同的画
const rigFactory = `function makeRig(MILES_ART, MILES_SVG) {\n${js.replace(/^import .*$/m, "").replace(/^export /gm, "")}\nreturn { mountMiles, milesCapsuleWidth };\n}\n`;

const svgOf = (src, name) => {
  const m = src.match(new RegExp(`export const ${name} = (\`[^\`]*\`|".*");`, "s"));
  if (!m) throw new Error(`没找到 ${name}`);
  return m[1][0] === "`" ? m[1].slice(1, -1) : JSON.parse(m[1]);
};
const constOf = (src, name) => {
  const m = src.match(new RegExp(`export const ${name} = (\\{.*?\\}) as const;`));
  if (!m) throw new Error(`没找到 ${name}`);
  return m[1];
};
const cmeiTs = fs.readFileSync(path.join(ROOT, "cmeiArt.ts"), "utf8");
const arts = [
  `const ART = ${constOf(milesTs, "MILES_ART")};`,
  `const CMEI_ART = ${constOf(cmeiTs, "CMEI_ART")};`,
  `const BIG_VIEWBOX = "20 140 860 1080";`,
  `const CMEI_BIG_VIEWBOX = "20 30 860 1080";   // 她放大后头顶高出 topY，大图往上多留一点`,
  `const MILES_SVG_SRC = ${JSON.stringify(svgOf(milesTs, "MILES_SVG"))};`,
  `const CMEI_SVG_SRC = ${JSON.stringify(svgOf(cmeiTs, "CMEI_SVG"))};`,
].join("\n") + "\n";

const src = fs.readFileSync(path.join(HERE, "preview.src.html"), "utf8");
for (const marker of ["/*__RIG__*/", "/*__ARTS__*/", "<!--BODY-->"]) {
  if (src.split(marker).length !== 2) throw new Error(`preview.src.html 里 ${marker} 要正好一处`);
}
// 用函数做替换：动作代码里有 $，字符串替换会把 $& 之类当成特殊写法
const page = src.replace("/*__RIG__*/", () => rigFactory).replace("/*__ARTS__*/", () => arts);
const [head, body] = page.split("<!--BODY-->");
fs.writeFileSync(path.join(ROOT, "preview.html"),
  '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  + head + "</head>\n<body>\n" + body + (body.endsWith("\n") ? "" : "\n") + "</body>\n</html>\n");
const artifact = arg("--artifact");
if (artifact) fs.writeFileSync(artifact, page.replace("<!--BODY-->", ""));
console.log(`preview.html 写好了（动作代码取自 ${ref}，已打 milesRig-iris-gaze.patch）${artifact ? `；Artifact 版：${artifact}` : ""}`);
