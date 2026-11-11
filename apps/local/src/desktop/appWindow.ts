import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * 托盘「打开天枢」开装好的应用窗口（11/11 本人定做法一）：本人把天枢装成了 Chrome / Edge 应用（第 44 条）时，
 * 到开始菜单的 Chrome / Edge 应用文件夹和桌面找名字叫「天枢」、参数带 --app-id 的快捷方式，用它的目标和参数启动
 * （应用已开着时网页清单的 launch_handler focus-existing 把原来的窗口带到前面）。找不到就退回开浏览器标签。
 * 找到一次就记住（快捷方式还在就一直用它）。只读快捷方式和浏览器的同步库，不改任何东西。
 */
export interface Shortcut { path: string; target: string; args: string }

const APP_NAME = "天枢";

/** 开始菜单里放应用快捷方式的文件夹：「Chrome Apps」「Chrome 应用」「Edge Apps」「Microsoft Edge 应用」之类（中英文都认）。 */
export function shortcutDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const programs = join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
  let apps: string[] = [];
  try { apps = readdirSync(programs, { withFileTypes: true }).filter((d) => d.isDirectory() && /(chrome|edge)/i.test(d.name) && /(apps|应用)/i.test(d.name)).map((d) => join(programs, d.name)); } catch { /* 没有开始菜单 */ }
  return [...apps, join(home, "Desktop")];
}

/** 这几个文件夹里名字叫「天枢」的快捷方式。 */
export function candidatePaths(dirs: string[]): string[] {
  return dirs.map((d) => join(d, `${APP_NAME}.lnk`)).filter((p) => existsSync(p));
}

/** 快捷方式参数里的 --app-id 和 --profile-directory。 */
export function appIdOf(args: string): { appId: string; profile: string | null } | null {
  const id = /--app-id=([a-p]{32})\b/.exec(args)?.[1];
  if (!id) return null;
  const profile = /--profile-directory=(?:"([^"]+)"|(\S+))/.exec(args);
  return { appId: id, profile: profile ? profile[1] ?? profile[2]! : null };
}

/** 把参数串拆开（双引号里的空格不拆，引号去掉）：execFile 再按需要加引号。 */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/(?:[^\s"]+|"[^"]*")+/g)) out.push(m[0].replace(/"/g, ""));
  return out;
}

/** 浏览器给这个应用记的网址里有没有天枢的地址：true 对得上，false 对不上，null 看不出来（读不到、格式变了）。 */
export type OriginCheck = (s: Shortcut, origin: string) => boolean | null;

/**
 * 挑哪一个：对得上天枢地址的只有一个就用它；一个都对不上、又只有一个看不出来的，也用它（只装了一个天枢）；
 * 别的情况（正式站和本地的都装了又分不清、只装了别的站）不用，退回开浏览器标签。
 */
export function pickShortcut(found: Shortcut[], origin: string, check: OriginCheck): Shortcut | null {
  // 开始菜单和桌面上指着同一个应用（同一个 app-id、同一个浏览器配置）的算一个
  const byApp = new Map<string, Shortcut>();
  for (const s of found) {
    const app = appIdOf(s.args);
    const key = app ? `${s.target.toLowerCase()}|${app.profile ?? ""}|${app.appId}` : null;
    if (key && !byApp.has(key)) byApp.set(key, s);
  }
  const apps = [...byApp.values()];
  const results = apps.map((s) => ({ s, ok: check(s, origin) }));
  const matched = results.filter((r) => r.ok === true);
  if (matched.length === 1) return matched[0]!.s;
  if (matched.length > 1) return null;
  const unknown = results.filter((r) => r.ok === null);
  return unknown.length === 1 && results.every((r) => r.ok !== false) ? unknown[0]!.s : null;
}

/**
 * 按浏览器的同步库（<User Data>/<配置>/Sync Data/LevelDB 里的 .log、.ldb）对：应用 id 后面不远处出现的网址里有天枢的地址就算对得上。
 * 这是浏览器的内部格式，读不到或没找到这个 id 时回 null（看不出来）。
 */
export function syncStoreCheck(env: NodeJS.ProcessEnv = process.env, home = homedir()): OriginCheck {
  return (s, origin) => {
    const app = appIdOf(s.args);
    if (!app) return null;
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const userData = /edge/i.test(s.target) ? join(local, "Microsoft", "Edge", "User Data") : join(local, "Google", "Chrome", "User Data");
    return originInStore(join(userData, app.profile ?? "Default", "Sync Data", "LevelDB"), app.appId, origin);
  };
}

export function originInStore(dir: string, appId: string, origin: string): boolean | null {
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /\.(log|ldb)$/.test(f)); } catch { return null; }
  let seen = false;
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(dir, f)).toString("latin1"); } catch { continue; }
    for (let i = text.indexOf(appId); i >= 0; i = text.indexOf(appId, i + 1)) {
      const urls = text.slice(i, i + 800).match(/https?:\/\/[A-Za-z0-9.\-:[\]]+/g) ?? [];
      if (!urls.length) continue;
      seen = true;
      if (urls.some((u) => u.toLowerCase() === origin.toLowerCase())) return true;
    }
  }
  return seen ? false : null;
}

/** 读快捷方式的目标和参数（系统自带的 WScript.Shell，只读）。读不出的不列。 */
export function readShortcuts(paths: string[]): Promise<Shortcut[]> {
  if (!paths.length || process.platform !== "win32") return Promise.resolve([]);
  const script = "[Console]::InputEncoding=[Text.Encoding]::UTF8; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $ws=New-Object -ComObject WScript.Shell; "
    + "$out=@(foreach($p in ([Console]::In.ReadToEnd() | ConvertFrom-Json)){ $s=$ws.CreateShortcut($p); [pscustomobject]@{path=$p;target=$s.TargetPath;args=$s.Arguments} }); ConvertTo-Json -InputObject $out -Compress";
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      try { resolve((JSON.parse(out) as Shortcut[]).filter((s) => typeof s?.target === "string" && s.target && typeof s.args === "string")); } catch { resolve([]); }
    });
    child.stdin.end(JSON.stringify(paths));
  });
}

/** 托盘点开：找应用快捷方式（记住找到的那个），找到就用它的目标和参数启动，找不到就交给 fallback（开浏览器标签）。 */
export class AppWindow {
  private remembered: Shortcut | null = null;
  constructor(
    private readonly url: string, private readonly fallback: (url: string) => void,
    private readonly find: () => Promise<Shortcut[]> = async () => readShortcuts(candidatePaths(shortcutDirs())),
    private readonly check: OriginCheck = syncStoreCheck(),
    private readonly launch: (target: string, args: string[]) => void = (target, args) => { execFile(target, args, { windowsHide: false }, () => {}); },
  ) {}

  async open(): Promise<void> {
    const s = await this.shortcut().catch(() => null);
    if (!s) { this.fallback(this.url); return; }
    this.launch(s.target, splitArgs(s.args));
  }

  private async shortcut(): Promise<Shortcut | null> {
    if (this.remembered && existsSync(this.remembered.path) && existsSync(this.remembered.target)) return this.remembered;
    this.remembered = null;
    let origin: string;
    try { origin = new URL(this.url).origin; } catch { return null; }
    const picked = pickShortcut((await this.find()).filter((s) => basename(s.path) === `${APP_NAME}.lnk` && existsSync(s.target)), origin, this.check);
    this.remembered = picked;
    return picked;
  }
}
