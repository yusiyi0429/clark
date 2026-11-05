import { embedded } from "../store.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Desktop, MenuAction, TrayState } from "./index.js";

/**
 * 托盘助手脚本：stdin 收 JSON 行命令，stdout 回 JSON 行。11/06 在 Win11 上实测：图标、中文提示、
 * 按状态换色、右键菜单、左键单击都通。坑：.NET Framework 的 Console.In.ReadLineAsync 实际是阻塞的，
 * 会卡住界面线程导致点不动，所以用后台线程读 stdin、界面计时器取队列。
 */
const TRAY_PS1 = embedded(String.raw`
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Collections.Concurrent; using System.Threading;
public static class StdinPump {
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  public static volatile bool Closed;
  public static void Start() {
    var t = new Thread(() => { string l; while ((l = Console.In.ReadLine()) != null) Lines.Enqueue(l); Closed = true; });
    t.IsBackground = true; t.Start();
  }
}
"@
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function New-DotIcon([string]$hex) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))), 1, 1, 14, 14)
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icons = @{ idle = (New-DotIcon '#5B7CFA'); busy = (New-DotIcon '#22A06B'); off = (New-DotIcon '#8A8F98'); paused = (New-DotIcon '#E5A23C') }
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icons.off
$ni.Text = '天枢本机程序'
$ni.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenu
$miOpen = New-Object System.Windows.Forms.MenuItem '打开天枢'
$miPause = New-Object System.Windows.Forms.MenuItem '暂停全部'
$miQuit = New-Object System.Windows.Forms.MenuItem '退出'
$miOpen.add_Click({ Out-Json @{ menu = 'open' } })
$miPause.add_Click({ if ($script:paused) { Out-Json @{ menu = 'resume' } } else { Out-Json @{ menu = 'pause' } } })
$miQuit.add_Click({ Out-Json @{ menu = 'quit' } })
[void]$menu.MenuItems.Add($miOpen); [void]$menu.MenuItems.Add($miPause); [void]$menu.MenuItems.Add('-'); [void]$menu.MenuItems.Add($miQuit)
$ni.ContextMenu = $menu
$ni.add_MouseClick({ param($s, $e) if ($e.Button -eq 'Left') { Out-Json @{ menu = 'open' } } })
$script:paused = $false
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.WindowState = 'Minimized'; $owner.Opacity = 0
[StdinPump]::Start()
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
  $line = $null
  while ([StdinPump]::Lines.TryDequeue([ref]$line)) {
    try { $m = $line | ConvertFrom-Json } catch { continue }
    switch ($m.cmd) {
      'state' {
        $ni.Text = ([string]$m.tooltip).Substring(0, [Math]::Min(63, ([string]$m.tooltip).Length))
        if ($icons.ContainsKey([string]$m.icon)) { $ni.Icon = $icons[[string]$m.icon] }
        $script:paused = [bool]$m.paused
        $miPause.Text = $(if ($script:paused) { '恢复' } else { '暂停全部' })
      }
      'confirm' {
        $owner.Show(); $owner.Activate()
        $r = [System.Windows.Forms.MessageBox]::Show($owner, [string]$m.text, [string]$m.title, 'YesNo', 'Question', 'Button2')
        $owner.Hide()
        Out-Json @{ reply = $m.id; ok = ($r -eq 'Yes') }
      }
      'pickFolder' {
        $owner.Show(); $owner.Activate()
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = '选择允许天枢本机程序读写的文件夹'
        $dlg.ShowNewFolderButton = $true
        $res = $dlg.ShowDialog($owner)
        $owner.Hide()
        Out-Json @{ reply = $m.id; path = $(if ($res -eq 'OK') { $dlg.SelectedPath } else { $null }) }
      }
      'quit' { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit(); return }
    }
  }
  if ([StdinPump]::Closed) { $ni.Visible = $false; [System.Windows.Forms.Application]::Exit() }
})
$timer.Start()
Out-Json @{ ready = $true }
[System.Windows.Forms.Application]::Run()
$ni.Dispose()
`);

export class WindowsDesktop implements Desktop {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly waiting = new Map<string, (r: any) => void>();

  async start(onMenu: (a: MenuAction) => void): Promise<void> {
    const encoded = Buffer.from(TRAY_PS1, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
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
