import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { embedded } from "../store.js";
import type { Desktop, MenuAction, TrayState } from "./index.js";

/**
 * 托盘助手（C#，WinForms）。第一次启动时用 Windows 自带的 .NET Framework 编译器（csc.exe）在本机编成约 10 KB 的小程序，
 * 放在 <数据目录>/bin/，之后直接起它：常驻约 25–30 MB（11/06 实测；原先用 PowerShell 宿主同一段逻辑要 100 MB 左右）。
 * 和本机程序之间是 stdin/stdout 的 JSON 行，协议见源码开头。源码一改，文件名里的哈希跟着变，自动重编。
 */
const TRAY_CS = embedded(String.raw`// 天枢本机程序的托盘助手（Windows）。stdin 收 JSON 行命令，stdout 回 JSON 行：
//   {"cmd":"state","tooltip":"…","icon":"idle|busy|off|paused","paused":bool}
//   {"cmd":"confirm","id":"…","title":"…","text":"…"}  → {"reply":"…","ok":bool}
//   {"cmd":"pickFolder","id":"…"}                       → {"reply":"…","path":"…"|null}
//   {"cmd":"quit"}
//   菜单点击 → {"menu":"open|pause|resume|quit"}；启动完成 → {"ready":true}
// 用 .NET Framework 自带的 csc（经 PowerShell Add-Type）在本机编成小 exe，常驻内存约 25 MB（PowerShell 宿主约 100 MB）。
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class TianshuTray {
  static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  static volatile bool closed;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static readonly object OutLock = new object();
  // 没有控制台的窗口程序不能设 Console.InputEncoding，直接在标准流上包 UTF-8 读写器。
  static readonly System.IO.StreamWriter StdOut = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };

  static void Out(Dictionary<string, object> o) {
    lock (OutLock) { StdOut.Write(Json.Serialize(o) + "\n"); }
  }

  static Icon Dot(Color c) {
    var bmp = new Bitmap(16, 16);
    using (var g = Graphics.FromImage(bmp)) {
      g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
      g.Clear(Color.Transparent);
      using (var b = new SolidBrush(c)) g.FillEllipse(b, 1, 1, 14, 14);
    }
    return Icon.FromHandle(bmp.GetHicon());
  }

  static string Str(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }

  [STAThread]
  public static void Main() {
    var icons = new Dictionary<string, Icon> {
      { "idle", Dot(ColorTranslator.FromHtml("#5B7CFA")) }, { "busy", Dot(ColorTranslator.FromHtml("#22A06B")) },
      { "off", Dot(ColorTranslator.FromHtml("#8A8F98")) }, { "paused", Dot(ColorTranslator.FromHtml("#E5A23C")) },
    };
    var ni = new NotifyIcon { Icon = icons["off"], Text = "天枢本机程序", Visible = true };
    bool paused = false;
    var menu = new ContextMenu();
    var miPause = new MenuItem("暂停全部", (s, e) => Out(new Dictionary<string, object> { { "menu", paused ? "resume" : "pause" } }));
    menu.MenuItems.Add(new MenuItem("打开天枢", (s, e) => Out(new Dictionary<string, object> { { "menu", "open" } })));
    menu.MenuItems.Add(miPause);
    menu.MenuItems.Add("-");
    menu.MenuItems.Add(new MenuItem("退出", (s, e) => Out(new Dictionary<string, object> { { "menu", "quit" } })));
    ni.ContextMenu = menu;
    ni.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Out(new Dictionary<string, object> { { "menu", "open" } }); };
    var owner = new Form { TopMost = true, ShowInTaskbar = false, WindowState = FormWindowState.Minimized, Opacity = 0 };

    var stdin = new System.IO.StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var reader = new Thread(() => { string l; while ((l = stdin.ReadLine()) != null) Lines.Enqueue(l); closed = true; });
    reader.IsBackground = true;
    reader.Start();

    var timer = new System.Windows.Forms.Timer { Interval = 150 };
    timer.Tick += (s, e) => {
      string line;
      while (Lines.TryDequeue(out line)) {
        Dictionary<string, object> m;
        try { m = Json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
        if (m == null) continue;
        switch (Str(m, "cmd")) {
          case "state": {
            var tip = Str(m, "tooltip");
            ni.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            Icon ic; if (icons.TryGetValue(Str(m, "icon"), out ic)) ni.Icon = ic;
            object p; paused = m.TryGetValue("paused", out p) && p is bool && (bool)p;
            miPause.Text = paused ? "恢复" : "暂停全部";
            break;
          }
          case "confirm": {
            owner.Show(); owner.Activate();
            var r = MessageBox.Show(owner, Str(m, "text"), Str(m, "title"), MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            owner.Hide();
            Out(new Dictionary<string, object> { { "reply", Str(m, "id") }, { "ok", r == DialogResult.Yes } });
            break;
          }
          case "pickFolder": {
            owner.Show(); owner.Activate();
            using (var dlg = new FolderBrowserDialog { Description = "选择允许天枢本机程序读写的文件夹", ShowNewFolderButton = true }) {
              var res = dlg.ShowDialog(owner);
              owner.Hide();
              Out(new Dictionary<string, object> { { "reply", Str(m, "id") }, { "path", res == DialogResult.OK ? dlg.SelectedPath : null } });
            }
            break;
          }
          case "quit":
            ni.Visible = false; Application.Exit(); return;
        }
      }
      if (closed) { ni.Visible = false; Application.Exit(); }
    };
    timer.Start();
    Out(new Dictionary<string, object> { { "ready", true } });
    Application.Run();
    ni.Dispose();
  }
}
`);

const CSC = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

function compileTray(binDir: string): Promise<string> {
  const hash = createHash("sha256").update(TRAY_CS).digest("hex").slice(0, 12);
  const exe = join(binDir, `tianshu-tray-${hash}.exe`);
  if (existsSync(exe)) return Promise.resolve(exe);
  mkdirSync(binDir, { recursive: true });
  const src = join(binDir, `tianshu-tray-${hash}.cs`);
  writeFileSync(src, TRAY_CS, "utf8");
  return new Promise((resolve, reject) => {
    execFile(CSC, ["/nologo", "/target:winexe", "/optimize+", "/codepage:65001", `/out:${exe}`,
      "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", "/r:System.Web.Extensions.dll", src],
    { windowsHide: true }, (err, stdout) => (err || !existsSync(exe) ? reject(new Error(`托盘助手编译失败：${String(stdout).slice(0, 300)}`)) : resolve(exe)));
  });
}

export class WindowsDesktop implements Desktop {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly waiting = new Map<string, (r: any) => void>();

  constructor(private readonly binDir: string) {}

  async start(onMenu: (a: MenuAction) => void): Promise<void> {
    let exe: string;
    try {
      exe = await compileTray(this.binDir);
    } catch (e) {
      // 编不出来（极少见：系统缺 .NET Framework 4）：本机程序照常跑，只是没有托盘和本机弹框。
      console.error(e instanceof Error ? e.message : e);
      return;
    }
    const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdin.on("error", () => {});
    let buf = "";
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000);
      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m: any;
          try { m = JSON.parse(line); } catch { continue; }
          if (m.ready) { clearTimeout(timer); resolve(); }
          if (m.menu) onMenu(m.menu as MenuAction);
          if (m.reply) { this.waiting.get(m.reply)?.(m); this.waiting.delete(m.reply); }
        }
      });
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  private ask(cmd: Record<string, unknown>): Promise<any> {
    if (!this.child || this.child.exitCode !== null) return Promise.resolve({});
    const id = randomBytes(6).toString("hex");
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child!.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
    });
  }

  setState(s: TrayState): void {
    const tooltip = !s.paired ? "天枢本机程序 · 还没连上天枢网页" : s.paused ? "天枢本机程序 · 已暂停" : s.running ? `天枢本机程序 · 正在跑 ${s.running} 张卡` : "天枢本机程序 · 已连接";
    const icon = s.paused ? "paused" : !s.paired ? "off" : s.running ? "busy" : "idle";
    this.child?.stdin.write(JSON.stringify({ cmd: "state", tooltip, icon, paused: s.paused }) + "\n");
  }

  async confirm(title: string, text: string): Promise<boolean> {
    const r = await this.ask({ cmd: "confirm", title, text });
    return r.ok === true;
  }

  async pickFolder(): Promise<string | null> {
    const r = await this.ask({ cmd: "pickFolder" });
    return typeof r.path === "string" && r.path ? r.path : null;
  }

  stop(): void {
    try { this.child?.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n"); this.child?.stdin.end(); } catch { /* 已退出 */ }
  }
}
