// 用 Bun 把本机程序编成单文件可执行程序（ADR 0028）。默认只编当前平台；--all 编 Windows x64 和 macOS arm64/x64。
// 需要本机装了 Bun（>=1.3）；找不到时用环境变量 BUN 指定路径。产物在 apps/local/dist/。
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.env.BUN ?? "bun";
const all = process.argv.includes("--all");
const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const targets = all ? ["windows-x64", "darwin-arm64", "darwin-x64"] : [host];
mkdirSync(join(root, "dist"), { recursive: true });

for (const t of targets) {
  const out = join(root, "dist", `tianshu-local-${t}${t.startsWith("windows") ? ".exe" : ""}`);
  const args = ["build", "--compile", "--minify", `--target=bun-${t}`, `--outfile=${out}`, join(root, "src", "main.ts")];
  if (t.startsWith("windows")) {
    // 开机自启时不弹控制台窗口；资源管理器里显示的名字和版本。
    args.push("--windows-hide-console", "--windows-title=天枢本机程序", "--windows-publisher=Tokenking", "--windows-version=0.1.0.0", "--windows-description=天枢本机程序");
  }
  console.log(`编 ${t} → ${out}`);
  execFileSync(bun, args, { stdio: "inherit", cwd: root });
}
