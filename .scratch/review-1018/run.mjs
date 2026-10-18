// 审核演示：同时起 API（4818）和网页（3818），任一退出就一起停。launch.json 的 review-1018 调这个文件。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const children = [
  spawn(process.execPath, [join(root, "apps/api/node_modules/tsx/dist/cli.mjs"), join(root, ".scratch/review-1018/api.ts")],
    { cwd: join(root, "apps/api"), stdio: ["ignore", "inherit", "inherit"] }),
  spawn(process.execPath, [join(root, "apps/web/node_modules/next/dist/bin/next"), "dev", "-p", "3818"],
    { cwd: join(root, "apps/web"), stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, API_SERVER_URL: "http://127.0.0.1:4818", NEXT_TELEMETRY_DISABLED: "1" } }),
];
const stop = () => { for (const child of children) if (child.exitCode === null) child.kill(); };
for (const child of children) child.on("exit", (code) => { stop(); process.exitCode = code ?? 0; });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { stop(); process.exit(); });
process.on("exit", stop);
