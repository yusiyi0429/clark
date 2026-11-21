import { execFile } from "node:child_process";
import { join } from "node:path";

/**
 * 接管脚本装的旧版（apps/local/scripts/install.ps1）：程序在 %LOCALAPPDATA%\Programs\Tianshu\tianshu-local.exe，
 * 开机自启是 HKCU\…\Run\TianshuLocal。桌面版启动时把旧版停掉、自启项删掉；数据目录（%LOCALAPPDATA%\Tianshu\local）不动，桌面版照用。
 * 程序文件和卸载脚本留着（本人想删可以跑那份卸载脚本，带 TIANSHU_LOCAL_PURGE 以外的默认不删数据）。
 */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "TianshuLocal";

export function legacyExe(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "Tianshu", "tianshu-local.exe") : null;
}

const run = (file: string, args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout) }));
});

/** 停掉旧版、删自启项。回做了什么（给日志）。不是 Windows 什么都不做。 */
export async function takeOverLegacy(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const done: string[] = [];
  const exe = legacyExe();
  if ((await run("reg.exe", ["query", RUN_KEY, "/v", RUN_VALUE])).ok) {
    if ((await run("reg.exe", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])).ok) done.push("删了旧版的开机自启");
  }
  if (exe) {
    // 只停这个路径的 tianshu-local（同名的别处程序、开发时用 node 跑的不碰）；它的托盘助手读不到 stdin 会自己退出
    const ps = `$p = Get-Process -Name 'tianshu-local' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' }; $p | Stop-Process -Force; ($p | Measure-Object).Count`;
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
    const n = Number(r.out.trim());
    if (n > 0) done.push(`停掉了旧版本机程序（${n} 个进程）`);
  }
  return done;
}
