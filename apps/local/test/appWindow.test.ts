// 托盘「打开天枢」开装好的应用窗口（11/11 本人定做法一）：找快捷方式、对网址、挑、启动、记住、找不到退回开标签。
// 全用假的快捷方式和假目录；Windows 上另用系统的 WScript.Shell 在临时文件夹里建真的 .lnk 读回来（不碰本人的开始菜单）。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppWindow, appIdOf, candidatePaths, originInStore, pickShortcut, readShortcuts, shortcutDirs, splitArgs, type Shortcut } from "../src/desktop/appWindow.js";
import { tempDir } from "./helpers.js";

const LOCAL_ID = "ikifenhfbnjklmbflopichijbjpimcpi";
const PROD_ID = "abcdefghijklmnopabcdefghijklmnop";
const lnk = (dir: string, id: string, profile = "Profile 3"): Shortcut => ({
  path: join(dir, "天枢.lnk"), target: "C:\\Program Files\\Google\\Chrome\\Application\\chrome_proxy.exe", args: ` --profile-directory="${profile}" --app-id=${id}`,
});

describe("找天枢的应用快捷方式", () => {
  it("开始菜单里 Chrome、Edge 的应用文件夹（中英文名）和桌面；别的文件夹不看；只认名字叫「天枢」的", () => {
    const home = tempDir("tl-aw-home-");
    const programs = join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs");
    for (const d of ["Chrome 应用", "Chrome Apps", "Microsoft Edge 应用", "Edge Apps", "Google Chrome", "工具"]) mkdirSync(join(programs, d), { recursive: true });
    mkdirSync(join(home, "Desktop"), { recursive: true });
    const dirs = shortcutDirs({ APPDATA: join(home, "AppData", "Roaming") }, home);
    expect(dirs.map((d) => d.slice(programs.length + 1) || d).sort()).toEqual(["Chrome Apps", "Chrome 应用", "Edge Apps", "Microsoft Edge 应用", join(home, "Desktop")].sort());
    writeFileSync(join(programs, "Chrome 应用", "天枢.lnk"), "");
    writeFileSync(join(programs, "Chrome 应用", "NotebookLM.lnk"), "");
    writeFileSync(join(programs, "工具", "天枢.lnk"), "");
    writeFileSync(join(home, "Desktop", "天枢.lnk"), "");
    expect(candidatePaths(dirs).sort()).toEqual([join(programs, "Chrome 应用", "天枢.lnk"), join(home, "Desktop", "天枢.lnk")].sort());
    rmSync(home, { recursive: true, force: true });
  });

  it("读参数：--app-id、--profile-directory（带引号、不带引号）；拆参数去掉引号、不拆引号里的空格", () => {
    expect(appIdOf(` --profile-directory="Profile 3" --app-id=${LOCAL_ID}`)).toEqual({ appId: LOCAL_ID, profile: "Profile 3" });
    expect(appIdOf(`--app-id=${LOCAL_ID} --profile-directory=Default`)).toEqual({ appId: LOCAL_ID, profile: "Default" });
    expect(appIdOf("--new-window https://example.com")).toBeNull();
    expect(splitArgs(` --profile-directory="Profile 3" --app-id=${LOCAL_ID}`)).toEqual(["--profile-directory=Profile 3", `--app-id=${LOCAL_ID}`]);
  });

  it("挑：对得上地址的只有一个用它；只装了一个、看不出地址的也用它；两个都看不出、只有别的站、不是应用的都不用", () => {
    const origin = "http://localhost:3700";
    const local = lnk("C:\\a", LOCAL_ID), prod = lnk("C:\\b", PROD_ID);
    const by = (m: Record<string, boolean | null>) => (s: Shortcut) => m[appIdOf(s.args)!.appId] ?? null;
    expect(pickShortcut([prod, local], origin, by({ [LOCAL_ID]: true, [PROD_ID]: false }))).toBe(local);
    expect(pickShortcut([local], origin, by({}))).toBe(local);
    expect(pickShortcut([prod, local], origin, by({}))).toBeNull();
    expect(pickShortcut([prod], origin, by({ [PROD_ID]: false }))).toBeNull();
    expect(pickShortcut([prod, local], origin, by({ [PROD_ID]: false }))).toBeNull(); // 一个对不上、一个看不出：不猜
    expect(pickShortcut([{ ...local, args: "--new-window" }], origin, by({}))).toBeNull();
    // 开始菜单和桌面各一个、指着同一个应用：算一个（本人电脑上就是这样）
    const desk = { ...lnk("C:\\Users\\x\\Desktop", LOCAL_ID) };
    expect(pickShortcut([local, desk], origin, by({ [LOCAL_ID]: true }))).toBe(local);
    expect(pickShortcut([local, desk], origin, by({}))).toBe(local);
  });

  it("按浏览器同步库对地址：应用 id 后面的网址里有天枢的地址为 true，只有别的为 false，读不到、没有这个 id 为 null", () => {
    const dir = tempDir("tl-aw-sync-");
    const rec = (id: string, url: string) => Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.from(`web_apps-dt-${id}`), Buffer.from([0x12, 0x01, 0x00]), Buffer.from(`${url}/me/work`), Buffer.from([0x1a, 0x02])]);
    writeFileSync(join(dir, "000123.log"), Buffer.concat([rec(LOCAL_ID, "http://localhost:3700"), rec(PROD_ID, "https://tk.tokenkingos.com")]));
    expect(originInStore(dir, LOCAL_ID, "http://localhost:3700")).toBe(true);
    expect(originInStore(dir, PROD_ID, "http://localhost:3700")).toBe(false);
    expect(originInStore(dir, "pppppppppppppppppppppppppppppppp", "http://localhost:3700")).toBeNull();
    expect(originInStore(join(dir, "没有"), LOCAL_ID, "http://localhost:3700")).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("点开：找到就用快捷方式的目标和参数启动，记住，下次不再找；快捷方式没了重新找；找不到退回开浏览器标签", async () => {
    const dir = tempDir("tl-aw-open-");
    const target = join(dir, "chrome_proxy.exe");
    writeFileSync(target, "");
    const path = join(dir, "天枢.lnk");
    writeFileSync(path, "");
    const s: Shortcut = { path, target, args: ` --profile-directory="Profile 3" --app-id=${LOCAL_ID}` };
    let finds = 0;
    const launched: [string, string[]][] = [];
    const tabs: string[] = [];
    const w = new AppWindow("http://localhost:3700", (u) => tabs.push(u), async () => { finds++; return [s]; }, () => null, (t, a) => launched.push([t, a]));
    await w.open();
    await w.open();
    expect(launched).toEqual([[target, ["--profile-directory=Profile 3", `--app-id=${LOCAL_ID}`]], [target, ["--profile-directory=Profile 3", `--app-id=${LOCAL_ID}`]]]);
    expect(finds).toBe(1);
    expect(tabs).toEqual([]);
    rmSync(path);
    await w.open(); // 快捷方式删了：重新找，找到的目标也不在了就开标签
    expect(finds).toBe(2);
    expect(tabs).toEqual([]);
    const none = new AppWindow("http://localhost:3700", (u) => tabs.push(u), async () => [], () => null, (t, a) => launched.push([t, a]));
    await none.open();
    expect(tabs).toEqual(["http://localhost:3700"]);
    const broken = new AppWindow("http://localhost:3700", (u) => tabs.push(u), async () => { throw new Error("读不出"); }, () => null, (t, a) => launched.push([t, a]));
    await broken.open();
    expect(tabs).toEqual(["http://localhost:3700", "http://localhost:3700"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it.runIf(process.platform === "win32")("Windows：用系统的 WScript.Shell 读真的 .lnk（临时文件夹里建的），中文名、带引号的参数都读得回来", async () => {
    const dir = tempDir("tl-aw-lnk-");
    const path = join(dir, "天枢.lnk");
    const args = ` --profile-directory="Profile 3" --app-id=${LOCAL_ID}`;
    const ps = "[Console]::InputEncoding=[Text.Encoding]::UTF8; $j=[Console]::In.ReadToEnd() | ConvertFrom-Json; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($j.path); $s.TargetPath=$j.target; $s.Arguments=$j.args; $s.Save()";
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { input: JSON.stringify({ path, target: process.execPath, args }), windowsHide: true });
    const [read] = await readShortcuts([path]);
    expect([read!.path, read!.target]).toEqual([path, process.execPath]);
    expect(appIdOf(read!.args)).toEqual({ appId: LOCAL_ID, profile: "Profile 3" });
    rmSync(dir, { recursive: true, force: true });
  }, 30_000); // 两次 PowerShell + COM：电脑刚重启时冷启动慢（11/11 实测 7 秒多），5 秒不够
});
