import { utilityProcess, type UtilityProcess } from "electron";

/** 本机程序报来的托盘状态（apps/local 的 TrayState）。 */
export interface TrayState { paired: boolean; running: number; paused: boolean }

export interface RunnerEvents {
  tray(state: TrayState): void;
  confirm(title: string, text: string): Promise<boolean>;
  pickFolder(): Promise<string | null>;
  /** 起好了。 */
  ready(info: { port: number; version: string }): void;
  /** 起不来（端口被占是 EADDRINUSE）。 */
  failed(info: { code: string | null; message: string }): void;
}

/**
 * 在 Electron 的 utilityProcess 里跑本机程序（dist/runner/hosted.cjs），按 apps/local/src/desktop/hosted.ts 的消息口说话。
 * 意外退出就重拉（间隔 2、4、8… 秒，最多 60 秒）；起不来（比如端口被占）不重拉，交给壳提示。
 */
export class RunnerHost {
  private child: UtilityProcess | null = null;
  private stopping = false;
  private retries = 0;

  constructor(private readonly modulePath: string, private readonly on: RunnerEvents) {}

  start(): void {
    this.stopping = false;
    const child = utilityProcess.fork(this.modulePath, [], { serviceName: "天枢本机程序", stdio: "inherit" });
    this.child = child;
    let failed = false;
    child.on("message", async (m: any) => {
      if (m?.type === "tray") this.on.tray(m.state);
      if (m?.type === "ready") { this.retries = 0; this.on.ready(m); }
      if (m?.type === "error") { failed = true; this.on.failed(m); }
      if (m?.type === "confirm") child.postMessage({ type: "reply", id: m.id, value: await this.on.confirm(m.title, m.text) });
      if (m?.type === "pickFolder") child.postMessage({ type: "reply", id: m.id, value: await this.on.pickFolder() });
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      if (this.stopping || failed) return;
      const wait = Math.min(60, 2 ** ++this.retries) * 1000;
      setTimeout(() => { if (!this.stopping && !this.child) this.start(); }, wait);
    });
  }

  /** 托盘的「暂停全部」「恢复」。 */
  menu(action: "pause" | "resume"): void { this.child?.postMessage({ type: "menu", action }); }

  /** 退出：让本机程序收尾（停掉会话进程）后自己退出；10 秒还没退就强停。 */
  stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 10_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.postMessage({ type: "menu", action: "quit" });
    });
  }
}
