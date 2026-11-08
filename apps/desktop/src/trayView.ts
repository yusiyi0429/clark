import type { TrayState } from "./runner";

/** 托盘四种状态的颜色，和本机程序原来的 C# 托盘一样（apps/local/src/desktop/windows.ts）。 */
export const TRAY_COLORS = { off: "#8A8F98", idle: "#5B7CFA", busy: "#22A06B", paused: "#E5A23C" } as const;
export type TrayIcon = keyof typeof TRAY_COLORS;

/**
 * 托盘显示什么（不依赖 Electron，单测直接测）。state 为 null：本机程序还没起来或起不来，error 是原因。
 * 文案和原来的托盘一样，只是把「天枢本机程序」换成「天枢」（桌面版就叫天枢）。
 */
export function trayView(state: TrayState | null, error: string | null = null): { icon: TrayIcon; tooltip: string; pauseLabel: string; canPause: boolean } {
  if (!state) return { icon: "off", tooltip: error ? `天枢 · 本机程序没起来：${error}`.slice(0, 120) : "天枢 · 本机程序启动中", pauseLabel: "暂停全部", canPause: false };
  const icon: TrayIcon = state.paused ? "paused" : !state.paired ? "off" : state.running ? "busy" : "idle";
  const tooltip = !state.paired ? "天枢 · 还没连上天枢网页" : state.paused ? "天枢 · 已暂停" : state.running ? `天枢 · 正在跑 ${state.running} 张卡` : "天枢 · 已连接";
  return { icon, tooltip, pauseLabel: state.paused ? "恢复" : "暂停全部", canPause: true };
}

/** 托盘图标：32×32 的实心圆点（BGRA），按 2 倍缩放给 16 像素的托盘。 */
export function dotBitmap(hex: string, size = 32): Buffer {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2 - 1.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, radius + 0.5 - d)); // 边缘抗锯齿
      const o = (y * size + x) * 4;
      // 预乘 alpha 的 BGRA
      buf[o] = Math.round(b! * a); buf[o + 1] = Math.round(g! * a); buf[o + 2] = Math.round(r! * a); buf[o + 3] = Math.round(255 * a);
    }
  }
  return buf;
}
