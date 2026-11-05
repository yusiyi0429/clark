import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

/** 开机自启：Windows 写 HKCU Run（不要管理员），macOS 写 LaunchAgent。11/06 在 Windows 上实测写入、删除。 */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "TianshuLocal";
const LABEL = "com.tokenkingos.tianshu-local";
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function enableAutostart(exePath: string): void {
  if (process.platform === "win32") {
    execFileSync("reg.exe", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${exePath}" run`, "/f"], { windowsHide: true, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(exePath)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plistPath(), plist);
    try { execFileSync("/bin/launchctl", ["bootstrap", `gui/${userInfo().uid}`, plistPath()], { stdio: "ignore" }); } catch { /* 已加载 */ }
  }
}

export function disableAutostart(): void {
  if (process.platform === "win32") {
    try { execFileSync("reg.exe", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], { windowsHide: true, stdio: "ignore" }); } catch { /* 本来就没有 */ }
  } else if (process.platform === "darwin") {
    try { execFileSync("/bin/launchctl", ["bootout", `gui/${userInfo().uid}/${LABEL}`], { stdio: "ignore" }); } catch { /* 没加载 */ }
    if (existsSync(plistPath())) rmSync(plistPath());
  }
}

export function autostartEnabled(): boolean {
  if (process.platform === "win32") {
    try { execFileSync("reg.exe", ["query", RUN_KEY, "/v", RUN_VALUE], { windowsHide: true, stdio: "ignore" }); return true; } catch { return false; }
  }
  if (process.platform === "darwin") return existsSync(plistPath());
  return false;
}
