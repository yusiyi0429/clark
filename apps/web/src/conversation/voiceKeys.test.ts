import { describe, expect, it } from "vitest";
import { createGesture, gestureCode, keyLabels, voiceBindings } from "./voiceKeys";

/** 实测：按住 Ctrl+Win 浏览器只收到 Win；左 Ctrl+U 只收到一下单按左 Ctrl。 */
const binds = voiceBindings({ tap: ["ControlLeft"] }, true);

describe("按住说话", () => {
  it("没录过时 Windows 上按住 Win 就算；Mac 上没有默认", () => {
    expect(binds.hold).toEqual(["MetaLeft"]);
    expect(voiceBindings({}, false)).toEqual({ hold: null, tap: null });
  });

  it("按住那几颗就开始计时，多按 Shift（微信免提）照样算；中间按了别的键（Win+E）就不算", () => {
    const g = createGesture();
    expect(g.down("MetaLeft", 0, binds)).toBe(true);
    expect(g.holding(binds)).toBe(true);
    expect(g.down("ShiftLeft", 30, binds)).toBe(true);
    expect(g.down("KeyE", 50, binds)).toBe(false);
    expect(g.holding(binds)).toBe(false);
  });

  it("唤醒过一次，松开时不再算「按一下」", () => {
    const same = voiceBindings({ hold: ["ControlLeft"], tap: ["ControlLeft"] }, true);
    const g = createGesture();
    g.down("ControlLeft", 0, same);
    g.fire();
    expect(g.up("ControlLeft", 200, same)).toBe(false);
  });
});

describe("启动语音输入", () => {
  it("单按左 Ctrl、0.5 秒内全部松开 → 唤醒；按太久、右 Ctrl、Ctrl+C 都不算", () => {
    const tap = (codes: string[], ms: number) => {
      const g = createGesture();
      codes.forEach((code) => g.down(code, 0, binds));
      return codes.map((code) => g.up(code, ms, binds)).at(-1);
    };
    expect(tap(["ControlLeft"], 100)).toBe(true);
    expect(tap(["ControlLeft"], 800)).toBe(false);
    expect(tap(["ControlRight"], 100)).toBe(false);
    expect(tap(["ControlLeft", "KeyC"], 100)).toBe(false);
  });

  it("按着 Ctrl 点了鼠标（spoil）不算；下一次手势重新算", () => {
    const g = createGesture();
    g.down("ControlLeft", 0, binds);
    g.spoil();
    expect(g.up("ControlLeft", 100, binds)).toBe(false);
    g.down("ControlLeft", 1000, binds);
    expect(g.up("ControlLeft", 1100, binds)).toBe(true);
  });

  it("没见过按下的松开不算", () => {
    expect(createGesture().up("ControlLeft", 10, binds)).toBe(false);
  });
});

describe("录入和键帽", () => {
  it("微信补发的说不出名字的键、组词中的键不参与", () => {
    expect(gestureCode({ key: "Unidentified", code: "", keyCode: 252 })).toBeNull();
    expect(gestureCode({ key: "Process", code: "KeyU", keyCode: 229 })).toBeNull();
    expect(gestureCode({ key: "Control", code: "ControlLeft", keyCode: 17 })).toBe("ControlLeft");
  });

  it("修饰键在前，左右分开写", () => {
    expect(keyLabels(["KeyU", "ControlLeft"], true)).toEqual(["左 Ctrl", "U"]);
    expect(keyLabels(["MetaLeft", "ControlLeft"], true)).toEqual(["左 Ctrl", "Win"]);
    expect(keyLabels(["Space", "ShiftRight", "ControlLeft"], true)).toEqual(["左 Ctrl", "右 Shift", "空格"]);
  });
});
