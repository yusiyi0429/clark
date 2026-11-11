// 造测试文件夹（只在系统临时目录下）。用法：node gen.mjs small|large <目标目录>
// small：60 个文件（Markdown、仿 Word/Excel 的二进制），中文名、深路径。
// large：约 5 万个文件、约 5GB：4.8 万个小文件 + 1000 个中等文件 + 1 个 1GB 大文件 + node_modules 1 万个小文件（该跳过的）。
import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const [, , kind, root] = process.argv;
if (!root || !root.toLowerCase().includes("\\temp\\")) throw new Error("只在系统临时目录下造");
mkdirSync(root, { recursive: true });

// 文本：可压缩；二进制：已压缩的 docx/xlsx 像随机字节。
const text = (n) => Buffer.from(("# 季度报告\n本月收入与支出明细，第 N 行。\n").repeat(Math.ceil(n / 60)).slice(0, n));
const bin = (n) => randomBytes(n);
function big(path, bytes) {
  const fd = openSync(path, "w");
  const chunk = randomBytes(8 * 1024 * 1024);
  for (let w = 0; w < bytes; w += chunk.length) writeSync(fd, chunk, 0, Math.min(chunk.length, bytes - w));
  closeSync(fd);
}

const t0 = Date.now();
if (kind === "small") {
  for (let i = 0; i < 20; i++) writeFileSync(join(root, `笔记-${i}.md`), text(2000 + i * 300));
  mkdirSync(join(root, "财务", "2026年", "11月"), { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(root, "财务", "2026年", "11月", `报销单-${i}.xlsx`), bin(30_000 + i * 5000));
  mkdirSync(join(root, "人事 文档"), { recursive: true });
  for (let i = 0; i < 20; i++) writeFileSync(join(root, "人事 文档", `合同-${i}.docx`), bin(80_000 + i * 10_000));
} else if (kind === "large") {
  // 4.8 万个小文件：每个目录 200 个，平均 20KB（一半文本一半二进制）
  for (let d = 0; d < 240; d++) {
    const dir = join(root, `项目${d}`, "资料");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, `文件${i}.${i % 2 ? "md" : "docx"}`), i % 2 ? text(20_000) : bin(20_000));
  }
  // 1000 个中等文件，平均 3MB（像 PDF、图片，不可压缩）
  mkdirSync(join(root, "扫描件"), { recursive: true });
  const mid = randomBytes(3 * 1024 * 1024);
  for (let i = 0; i < 1000; i++) { mid.writeUInt32LE(i, 0); writeFileSync(join(root, "扫描件", `扫描${i}.pdf`), mid); }
  // 一个 1GB 的大文件
  big(join(root, "录像.mp4"), 1024 * 1024 * 1024);
  // node_modules：1 万个小文件，该跳过
  for (let d = 0; d < 50; d++) {
    const dir = join(root, "tool", "node_modules", `pkg${d}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${i}.js`), text(2000));
  }
}
console.log(JSON.stringify({ kind, root, ms: Date.now() - t0 }));
