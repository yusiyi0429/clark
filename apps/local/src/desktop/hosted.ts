import type { Desktop, MenuAction, TrayState } from "./index.js";

/**
 * 由天枢桌面版托管（apps/desktop，设计稿 17.5）：本机程序跑在 Electron 的 utilityProcess 里，托盘、确认框、选文件夹都交给壳做。
 * 和壳之间走 utilityProcess 的消息口（process.parentPort），不引 Electron，只认这几种消息：
 *   本机 → 壳：{type:"tray", state}、{type:"confirm", id, title, text}、{type:"pickFolder", id}
 *   壳 → 本机：{type:"menu", action}、{type:"reply", id, value}
 * 「打开天枢」由壳自己开窗口，不经本机程序。
 */
export interface HostPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown }) => void): unknown;
}

type Reply = { type: "reply"; id: number; value: unknown };
type Menu = { type: "menu"; action: MenuAction };

export class HostedDesktop implements Desktop {
  private seq = 0;
  private readonly waiting = new Map<number, (value: unknown) => void>();
  private onMenu: ((a: MenuAction) => void) | null = null;

  constructor(private readonly port: HostPort) {
    port.on("message", (e) => {
      const m = e.data as Reply | Menu | null;
      if (m?.type === "reply") { this.waiting.get(m.id)?.(m.value); this.waiting.delete(m.id); }
      if (m?.type === "menu" && ["pause", "resume", "quit"].includes(m.action)) this.onMenu?.(m.action);
    });
  }

  private ask(message: Record<string, unknown>): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.port.postMessage({ ...message, id });
    });
  }

  async start(onMenu: (a: MenuAction) => void): Promise<void> { this.onMenu = onMenu; }
  setState(state: TrayState): void { this.port.postMessage({ type: "tray", state }); }
  async confirm(title: string, text: string): Promise<boolean> { return (await this.ask({ type: "confirm", title, text })) === true; }
  async pickFolder(): Promise<string | null> {
    const v = await this.ask({ type: "pickFolder" });
    return typeof v === "string" && v ? v : null;
  }
  stop(): void {
    // 壳那边没回的就当拒绝、没选
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
  }
}
