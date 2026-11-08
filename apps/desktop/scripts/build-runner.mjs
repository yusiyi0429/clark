// 把本机程序（apps/local）的桌面版入口打成一个 CommonJS 文件，放进壳的产物：dist/runner/hosted.cjs。
// 壳用 Electron 的 utilityProcess 跑它，用的是 Electron 自带的 Node（本机程序源码只用 node: 标准库，ADR 0028 的约束不变）。
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [join(root, "..", "local", "src", "hosted.ts")],
  outfile: join(root, "dist", "runner", "hosted.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  logLevel: "warning",
});
console.log("本机程序 → dist/runner/hosted.cjs");
