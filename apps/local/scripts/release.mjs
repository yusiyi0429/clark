// 准备下载源要放的文件，不发布（发布步骤见 docs/guides/local-runner.md「打包和发布」）。
//   node scripts/release.mjs [--skip-build]     编三个平台 → 拷安装、卸载脚本 → 写 SHA256SUMS → 自查；产物在 dist/release/<版本>/
//   node scripts/release.mjs --verify <下载源>   发布后核对线上：每个文件哈希和 SHA256SUMS 一致，脚本和 SHA256SUMS 带 charset=utf-8
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES = ["tianshu-local-windows-x64.exe", "tianshu-local-darwin-arm64", "tianshu-local-darwin-x64"];
const SCRIPTS = ["install.ps1", "uninstall.ps1", "install.sh", "uninstall.sh"];
/** 这几个是文本，下载源要回 Content-Type: text/plain; charset=utf-8（PowerShell 5.1 的 irm 没有 charset 时按 ISO-8859-1 解码，中文全乱）。 */
const TEXT = [...SCRIPTS, "SHA256SUMS"];
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function verify(base) {
  base = base.replace(/\/$/, "");
  const res = await fetch(`${base}/SHA256SUMS`);
  if (!res.ok) fail(`取不到 ${base}/SHA256SUMS：HTTP ${res.status}`);
  const sums = new Map((await res.text()).trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([h, n]) => [n, h]));
  let bad = 0;
  for (const name of [...BINARIES, ...TEXT]) {
    const r = await fetch(`${base}/${name}`);
    const type = r.headers.get("content-type") ?? "";
    const body = Buffer.from(await r.arrayBuffer());
    const problems = [];
    if (!r.ok) problems.push(`HTTP ${r.status}`);
    if (TEXT.includes(name) && !/charset=utf-8/i.test(type)) problems.push(`Content-Type 是「${type}」，要带 charset=utf-8`);
    if (name !== "SHA256SUMS" && sums.get(name) !== sha256(body)) problems.push("哈希和 SHA256SUMS 对不上");
    console.log(`${problems.length ? "✗" : "✓"} ${name}${problems.length ? "：" + problems.join("；") : ""}`);
    bad += problems.length ? 1 : 0;
  }
  if (bad) fail(`${bad} 个文件有问题`);
  console.log("下载源核对通过");
}

function prepare(skipBuild) {
  const version = /VERSION = "([^"]+)"/.exec(readFileSync(join(root, "src", "config.ts"), "utf8"))?.[1];
  if (!version) fail("src/config.ts 里没找到 VERSION");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (pkg !== version) fail(`package.json 的版本 ${pkg} 和程序报的 ${version} 不一致`);
  if (!skipBuild) execFileSync(process.execPath, [join(root, "scripts", "build.mjs"), "--all"], { stdio: "inherit", cwd: root });

  const out = join(root, "dist", "release", version);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const b of BINARIES) copyFileSync(join(root, "dist", b), join(out, b));
  for (const s of SCRIPTS) copyFileSync(join(root, "scripts", s), join(out, s));

  // 自查：这几条错了，装的人那边会直接失败或乱码。
  const bytes = (n) => readFileSync(join(out, n));
  const bom = (n) => bytes(n).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  if (bom("install.ps1")) fail("install.ps1 不能带 BOM（irm | iex 时第一行会变成乱码命令）");
  if (!bom("uninstall.ps1")) fail("uninstall.ps1 要带 BOM（powershell -File 在 5.1 下没有 BOM 按本地代码页读，中文会乱）");
  for (const s of ["install.sh", "uninstall.sh"]) if (bytes(s).includes(0x0d)) fail(`${s} 里有 CR（要 LF 换行，否则 sh 报错）`);
  if (bytes(BINARIES[0]).subarray(0, 2).toString("latin1") !== "MZ") fail(`${BINARIES[0]} 不是 Windows 程序`);
  for (const b of BINARIES.slice(1)) if (bytes(b).readUInt32LE(0) !== 0xfeedfacf) fail(`${b} 不是 64 位 macOS 程序`);

  const files = readdirSync(out).sort();
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${sha256(bytes(f))}  ${f}\n`).join(""));
  console.log(`\n天枢本机程序 ${version} 的下载源文件（${out}）：`);
  for (const f of [...files, "SHA256SUMS"]) console.log(`  ${f.padEnd(34)} ${(statSync(join(out, f)).size / 1024 / 1024).toFixed(1).padStart(6)} MB`);
  console.log("\n下一步：按 runbook「打包和发布」上传这个目录，再跑 node scripts/release.mjs --verify <下载源地址>。");
}

const i = process.argv.indexOf("--verify");
if (i >= 0) {
  if (!process.argv[i + 1]) fail("用法：--verify <下载源地址>");
  await verify(process.argv[i + 1]);
} else {
  prepare(process.argv.includes("--skip-build"));
}
