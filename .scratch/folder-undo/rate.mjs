// 分开测每个文件、每 MB 的成本：A 组 1 万个 20KB 小文件；B 组 300 个 3MB 真随机文件。三种写法：git add（散对象）、git add 直接写包、fast-import。
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Shadow } from "./shadow.mjs";
import { FastShadow } from "./fastsnap.mjs";
const E = process.argv[2];
if (!E.toLowerCase().includes("\\temp\\")) throw new Error("temp only");
const A = join(E, "rateA"), B = join(E, "rateB");
const regen = !process.argv[3];
if (regen) for (const d of [A, B]) rmSync(d, { recursive: true, force: true });
if (regen) for (let d = 0; d < 50; d++) { mkdirSync(join(A, `d${d}`), { recursive: true }); for (let i = 0; i < 200; i++) writeFileSync(join(A, `d${d}`, `f${i}.docx`), randomBytes(20_000)); }
if (regen) { mkdirSync(B, { recursive: true }); } if (regen) for (let i = 0; i < 300; i++) writeFileSync(join(B, `s${i}.pdf`), randomBytes(3 << 20));
const ways = {
  loose: async (s) => { await s.git(["add", "-A", "--", "."]); },
  bulk: async (s) => { await s.git(["-c", "core.bigFileThreshold=1", "-c", "core.fscache=true", "-c", "core.compression=1", "add", "-A", "--", "."]); },
  fastimport: async (s) => { await s.fastSnapshot("base"); },
};
for (const [set, dir] of [["A 1万×20KB", A], ["B 300×3MB", B]]) for (const [w, fn] of Object.entries(ways)) {
  const g = join(E, `rate-${w}.git`); rmSync(g, { recursive: true, force: true });
  const s = new FastShadow(g, dir, "r"); await s.init();
  const t = performance.now(); await fn(s); console.log(set, w, Math.round(performance.now() - t), "ms");
}
