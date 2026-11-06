import { execFile } from "node:child_process";
import { join } from "node:path";
import { WindowsDesktop } from "./windows.js";
import { MacDesktop } from "./darwin.js";

export type MenuAction = "open" | "pause" | "resume" | "quit";
export interface TrayState { paired: boolean; running: number; paused: boolean }

/**
 * 托盘和本机弹框。Windows 用系统自带的 .NET Framework 编出的 C# 小程序（WinForms，源码嵌在程序里），
 * macOS 用系统自带的 osascript（JXA 菜单栏 + display dialog / choose folder）。都不需要另装东西。
 */
export interface Desktop {
  start(onMenu: (a: MenuAction) => void): Promise<void>;
  setState(s: TrayState): void;
  confirm(title: string, text: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  stop(): void;
}

export function openUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  if (process.platform === "win32") execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, () => {});
  else if (process.platform === "darwin") execFile("/usr/bin/open", [url], () => {});
  else execFile("xdg-open", [url], () => {});
}

/** 没有托盘的环境（Linux、测试、--headless）：配对只在设了 TIANSHU_LOCAL_AUTO_APPROVE=1 时自动通过，只给开发和测试用。 */
export class HeadlessDesktop implements Desktop {
  async start() {}
  setState() {}
  async confirm() { return process.env.TIANSHU_LOCAL_AUTO_APPROVE === "1"; }
  async pickFolder() { return process.env.TIANSHU_LOCAL_PICK_FOLDER ?? null; }
  stop() {}
}

export function createDesktop(headless: boolean, dataDir: string): Desktop {
  if (headless) return new HeadlessDesktop();
  if (process.platform === "win32") return new WindowsDesktop(join(dataDir, "bin"));
  if (process.platform === "darwin") return new MacDesktop();
  return new HeadlessDesktop();
}
