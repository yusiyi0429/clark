// 开工前先数一遍：文件数、总大小、大文件、目录联接（要排除），看要多久。用法：node scan.mjs <文件夹>
import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { SKIP_DIRS } from "./shadow.mjs";

const BIG = 32 * 1024 * 1024;
const t0 = performance.now();
let files = 0, bytes = 0, skippedDirs = 0;
const big = [], links = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) { links.push(p); continue; } // Windows 上目录联接也算 symlink
    if (e.isDirectory()) { if (SKIP_DIRS.includes(e.name)) skippedDirs++; else walk(p); continue; }
    if (!e.isFile()) continue;
    const size = lstatSync(p).size;
    files++;
    if (size > BIG) big.push({ p, size }); else bytes += size;
  }
};
walk(process.argv[2]);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), files, smallMB: Math.round(bytes / 1048576), big: big.length, bigMB: Math.round(big.reduce((a, b) => a + b.size, 0) / 1048576), links: links.length, skippedDirs }));
