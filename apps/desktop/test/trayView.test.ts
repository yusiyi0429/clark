import { describe, expect, it } from "vitest";
import { dotBitmap, trayView } from "../src/trayView";

describe("托盘显示", () => {
  it("四种状态和原来的托盘一样：没配对灰、已连接蓝、正在跑绿、暂停橙；本机程序没起来时灰、说原因、不能暂停", () => {
    expect(trayView({ paired: false, running: 0, paused: false })).toMatchObject({ icon: "off", tooltip: "天枢 · 还没连上天枢网页", pauseLabel: "暂停全部", canPause: true });
    expect(trayView({ paired: true, running: 0, paused: false })).toMatchObject({ icon: "idle", tooltip: "天枢 · 已连接" });
    expect(trayView({ paired: true, running: 2, paused: false })).toMatchObject({ icon: "busy", tooltip: "天枢 · 正在跑 2 张卡" });
    expect(trayView({ paired: true, running: 2, paused: true })).toMatchObject({ icon: "paused", tooltip: "天枢 · 已暂停", pauseLabel: "恢复" });
    expect(trayView(null)).toMatchObject({ icon: "off", tooltip: "天枢 · 本机程序启动中", canPause: false });
    expect(trayView(null, "端口 47610 被别的程序占着").tooltip).toBe("天枢 · 本机程序没起来：端口 47610 被别的程序占着");
  });

  it("图标是 32×32 的圆点：中心是给的颜色、四角透明", () => {
    const b = dotBitmap("#22A06B");
    expect(b.length).toBe(32 * 32 * 4);
    const px = (x: number, y: number) => [...b.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
    expect(px(16, 16)).toEqual([0x6b, 0xa0, 0x22, 255]); // BGRA
    expect(px(0, 0)[3]).toBe(0);
  });
});
