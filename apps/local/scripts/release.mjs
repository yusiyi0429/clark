// 准备下载源要放的文件，不发布（发布步骤见 docs/guides/local-runner.md「打包和发布」）。
//   node scripts/release.mjs [--skip-build]     编三个平台 → 拷安装、卸载脚本 → 写 SHA256SUMS → 自查；产物在 dist/release/<版本>/
//   node scripts/release.mjs --verify <下载源>   发布后核对线上：每个文件哈希和 SHA256SUMS 一致，脚本和 SHA256SUMS 带 charset=utf-8
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BINARIES = ["tianshu-local-windows-x64.exe", "tianshu-local-darwin-arm64", "tianshu-local-darwin-x64"];
const SCRIPTS = ["install.ps1", "uninstall.ps1", "install.sh", "uninstall.sh"];
/** 这几个是文本，下载源要回 Content-Type: text/plain; charset=utf-8（PowerShell 5.1 的 irm 没有 charset 时按 ISO-8859-1 解码，中文全乱）。 */
const TEXT = [...SCRIPTS, "SHA256SUMS"];
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * 不在 Mac 上也能查 macOS 程序的临时签名：按 Apple 的算法（最后一页只算到 codeLimit）重算每页哈希，和签名里的对比。
 * Apple 芯片上签名对不上的程序一启动就被系统杀掉。11/06 实测 Bun 1.3.13 在 Windows 上交叉编出的两个都对不上：
 * arm64 最后一页按整页补零算了哈希，x64 带的是 Bun 运行时原来的链接器签名（没覆盖我们的代码）。
 */
function machoSignatureProblem(b) {
  let off = 32, sig = null;
  for (let i = 0, n = b.readUInt32LE(16); i < n; i++) {
    if (b.readUInt32LE(off) === 0x1d) sig = b.readUInt32LE(off + 8); // LC_CODE_SIGNATURE
    off += b.readUInt32LE(off + 4);
  }
  if (sig === null) return "没有签名";
  let cd = null;
  for (let i = 0, n = b.readUInt32BE(sig + 8); i < n; i++) if (b.readUInt32BE(sig + 12 + i * 8) === 0) cd = sig + b.readUInt32BE(sig + 16 + i * 8);
  if (cd === null || b.readUInt32BE(cd) !== 0xfade0c02) return "签名里没有 CodeDirectory";
  const hashOffset = b.readUInt32BE(cd + 16), slots = b.readUInt32BE(cd + 28), codeLimit = b.readUInt32BE(cd + 32), hashSize = b[cd + 36], page = 1 << b[cd + 39];
  if (b[cd + 37] !== 2) return "签名不是 SHA-256";
  if (codeLimit !== sig) return `签名只覆盖到 ${codeLimit} 字节，签名在 ${sig}（签完又改过程序）`;
  let bad = 0;
  for (let i = 0; i < slots; i++) {
    const want = b.subarray(cd + hashOffset + i * hashSize, cd + hashOffset + (i + 1) * hashSize);
    if (!createHash("sha256").update(b.subarray(i * page, Math.min((i + 1) * page, codeLimit))).digest().equals(want)) bad++;
  }
  return bad ? `${bad} 页哈希对不上` : null;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function verify(base) {
  base = base.replace(/\/$/, "");
  const res = await fetch(`${base}/SHA256SUMS`);
  if (!res.ok) fail(`取不到 ${base}/SHA256SUMS：HTTP ${res.status}`);
  const online = await res.text();
  // 线上要是这次准备的那一版：只查线上自洽的话，整套旧版本或缓存里的旧副本也会通过。
  const local = join(root, "dist", "release", readVersion(), "SHA256SUMS");
  if (!existsSync(local)) fail(`本地没有 ${local}，先跑一次准备（不带 --verify）`);
  if (online.trim() !== readFileSync(local, "utf8").trim()) fail("线上的 SHA256SUMS 和本地这次准备的不一样（传的不是这一版，或下载源有缓存）");
  const sums = new Map(online.trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([h, n]) => [n, h]));
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

function readVersion() {
  const version = /VERSION = "([^"]+)"/.exec(readFileSync(join(root, "src", "config.ts"), "utf8"))?.[1];
  if (!version) fail("src/config.ts 里没找到 VERSION");
  return version;
}

function prepare(skipBuild) {
  const version = readVersion();
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
  // Mac 版 12 月才上，这里只提醒；上 Mac 版前按 runbook「打包和发布」第 3 步在 Mac 上重签。
  const unsigned = BINARIES.slice(1).map((b) => [b, machoSignatureProblem(bytes(b))]).filter(([, p]) => p);

  const files = readdirSync(out).sort();
  writeFileSync(join(out, "SHA256SUMS"), files.map((f) => `${sha256(bytes(f))}  ${f}\n`).join(""));
  console.log(`\n天枢本机程序 ${version} 的下载源文件（${out}）：`);
  for (const f of [...files, "SHA256SUMS"]) console.log(`  ${f.padEnd(34)} ${(statSync(join(out, f)).size / 1024 / 1024).toFixed(1).padStart(6)} MB`);
  for (const [b, p] of unsigned) console.log(`\n⚠ ${b} 的签名不可用（${p}）${b.endsWith("arm64") ? "，Apple 芯片要求签名有效" : ""}。上 Mac 版前在 Mac 上重签（runbook「打包和发布」第 3 步）。`);
  console.log("\n下一步：按 runbook「打包和发布」上传这个目录，再跑 node scripts/release.mjs --verify <下载源地址>。");
}

const i = process.argv.indexOf("--verify");
if (i >= 0) {
  if (!process.argv[i + 1]) fail("用法：--verify <下载源地址>");
  await verify(process.argv[i + 1]);
} else {
  prepare(process.argv.includes("--skip-build"));
}
