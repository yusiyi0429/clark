import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Desktop, MenuAction, TrayState } from "./index.js";

/**
 * macOS：菜单栏图标用系统自带 osascript 跑 JXA（ObjC 桥接 NSStatusBar），弹框用 display dialog / choose folder。
 * 这一份没在 Mac 上跑过（11/06 只有 Windows），12 月做 Mac 版时实测；走不通就换成 CI 在 macOS 上编的小 Swift 助手，接口不变。
 */
const MENUBAR_JXA = String.raw`
ObjC.import('Cocoa');
ObjC.import('Foundation');
const app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
const out = (o) => { $.NSFileHandle.fileHandleWithStandardOutput.writeData($(JSON.stringify(o) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); };
ObjC.registerSubclass({
  name: 'TianshuTarget',
  methods: {
    'open:': { types: ['void', ['id']], implementation: () => out({ menu: 'open' }) },
    'pause:': { types: ['void', ['id']], implementation: () => out({ menu: globalThis.paused ? 'resume' : 'pause' }) },
    'quit:': { types: ['void', ['id']], implementation: () => out({ menu: 'quit' }) },
  },
});
const target = $.TianshuTarget.alloc.init;
const item = $.NSStatusBar.systemStatusBar.statusItemWithLength($.NSVariableStatusItemLength);
item.button.title = '天枢';
const menu = $.NSMenu.alloc.init;
const add = (title, sel) => { const m = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, sel, ''); m.target = target; menu.addItem(m); return m; };
add('打开天枢', 'open:');
const pauseItem = add('暂停全部', 'pause:');
menu.addItem($.NSMenuItem.separatorItem);
add('退出', 'quit:');
item.menu = menu;
const stdin = $.NSFileHandle.fileHandleWithStandardInput;
let buf = '';
$.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock($.NSFileHandleDataAvailableNotification, stdin, $.NSOperationQueue.mainQueue, () => {
  const data = stdin.availableData;
  if (data.length === 0) { app.terminate(null); return; }
  buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m.cmd === 'state') { item.button.title = m.title; item.button.toolTip = m.tooltip; globalThis.paused = m.paused; pauseItem.title = m.paused ? '恢复' : '暂停全部'; }
      if (m.cmd === 'quit') app.terminate(null);
    } catch (e) {}
  }
  stdin.waitForDataInBackgroundAndNotify;
});
stdin.waitForDataInBackgroundAndNotify;
out({ ready: true });
app.run;
`;

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function osascript(script: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], (err, stdout) => resolve({ code: err ? 1 : 0, out: String(stdout).trim() }));
  });
}

export class MacDesktop implements Desktop {
  private child: ChildProcessWithoutNullStreams | null = null;

  async start(onMenu: (a: MenuAction) => void): Promise<void> {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", MENUBAR_JXA], { stdio: ["pipe", "pipe", "pipe"] });
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
          try {
            const m = JSON.parse(line);
            if (m.ready) { clearTimeout(timer); resolve(); }
            if (m.menu) onMenu(m.menu as MenuAction);
          } catch { /* 忽略 */ }
        }
      });
      child.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }

  setState(s: TrayState): void {
    const title = s.paused ? "天枢 ⏸" : s.running ? `天枢 ${s.running}` : "天枢";
    const tooltip = !s.paired ? "还没连上天枢网页" : s.paused ? "已暂停" : s.running ? `正在跑 ${s.running} 张卡` : "已连接";
    this.child?.stdin.write(JSON.stringify({ cmd: "state", title, tooltip, paused: s.paused }) + "\n");
  }

  async confirm(title: string, text: string): Promise<boolean> {
    const r = await osascript(`display dialog "${esc(text)}" with title "${esc(title)}" buttons {"拒绝", "允许"} default button "拒绝" cancel button "拒绝" with icon caution`);
    return r.code === 0 && r.out.includes("允许");
  }

  async pickFolder(): Promise<string | null> {
    const r = await osascript(`POSIX path of (choose folder with prompt "选择允许天枢本机程序读写的文件夹")`);
    return r.code === 0 && r.out ? r.out : null;
  }

  stop(): void {
    try { this.child?.stdin.write(JSON.stringify({ cmd: "quit" }) + "\n"); this.child?.stdin.end(); } catch { /* 已退出 */ }
  }
}
