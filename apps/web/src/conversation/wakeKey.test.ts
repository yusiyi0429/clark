import { describe, expect, it } from "vitest";
import { isWakeKey, keepsDefault, modalOpen } from "./wakeKey";

const key = (patch: Partial<Parameters<typeof isWakeKey>[0]>) => ({
  key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, ...patch,
});
const F13 = key({ key: "F13", code: "F13" });
const COMBO = key({ key: " ", code: "Space", ctrlKey: true, shiftKey: true, keyCode: 32 });
/** Windows 上按下 Ctrl 再按 Win（微信语音键）：凑齐的那一下是 Meta 的 keydown。 */
const CTRL_WIN = key({ key: "Meta", code: "MetaLeft", ctrlKey: true, metaKey: true, keyCode: 91 });
const field = (inComposer: boolean) => ({ tagName: "TEXTAREA", isContentEditable: false, closest: (selector: string) => (inComposer && selector.includes("global-controls") ? {} : null) });

describe("唤醒键：哪些按法算", () => {
  it("F13、Ctrl+Shift+Space 在哪个系统上都算", () => {
    for (const windows of [true, false]) {
      expect(isWakeKey(F13, null, windows)).toBe(true);
      expect(isWakeKey(COMBO, null, windows)).toBe(true);
    }
    expect(isWakeKey(key({ key: " ", code: "Space", ctrlKey: true, keyCode: 32 }), null, true)).toBe(false);
    expect(isWakeKey(key({ key: " ", code: "Space", ctrlKey: true, shiftKey: true, metaKey: true, keyCode: 32 }), null, false)).toBe(false);
  });

  it("微信的语音键 Ctrl+Win（含免提 Ctrl+Win+Shift）只在 Windows 上算，且不挡默认行为", () => {
    expect(isWakeKey(CTRL_WIN, null, true)).toBe(true);
    expect(isWakeKey(key({ key: "Control", code: "ControlLeft", ctrlKey: true, metaKey: true, keyCode: 17 }), null, true)).toBe(true);
    expect(isWakeKey(key({ key: "Shift", code: "ShiftLeft", ctrlKey: true, metaKey: true, shiftKey: true, keyCode: 16 }), null, true)).toBe(true);
    expect(keepsDefault(CTRL_WIN)).toBe(true);
    expect(keepsDefault(F13)).toBe(false);
    expect(keepsDefault(COMBO)).toBe(false);
    // macOS 上 Control+Command 是系统组合键的前半截（全屏、锁屏、表情），不算。
    expect(isWakeKey(CTRL_WIN, null, false)).toBe(false);
  });

  it("Ctrl+Win 再加别的键（切虚拟桌面的箭头、Alt）不算", () => {
    expect(isWakeKey(key({ key: "ArrowRight", code: "ArrowRight", ctrlKey: true, metaKey: true, keyCode: 39 }), null, true)).toBe(false);
    expect(isWakeKey(key({ key: "Meta", code: "MetaLeft", ctrlKey: true, metaKey: true, altKey: true, keyCode: 91 }), null, true)).toBe(false);
  });

  it("按住不放的自动重复、输入法组词中都不算", () => {
    expect(isWakeKey({ ...CTRL_WIN, repeat: true }, null, true)).toBe(false);
    expect(isWakeKey({ ...COMBO, isComposing: true }, null, true)).toBe(false);
    expect(isWakeKey({ ...COMBO, key: "Process", keyCode: 229 }, null, true)).toBe(false);
  });

  it("焦点在别的输入框里不抢（微信语音照常写进那个框）；输入条自己的输入框不算「别的」", () => {
    for (const event of [F13, COMBO, CTRL_WIN]) {
      expect(isWakeKey(event, field(false), true)).toBe(false);
      expect(isWakeKey(event, { tagName: "DIV", isContentEditable: true, closest: () => null }, true)).toBe(false);
      expect(isWakeKey(event, field(true), true)).toBe(true);
      expect(isWakeKey(event, { tagName: "BUTTON", closest: () => null }, true)).toBe(true);
    }
  });
});

describe("模态对话框", () => {
  it("确认框、aria-modal 浮层、原生 dialog、把输入条所在外壳设成 inert 的弹窗算模态；对话层自己（aria-modal=false、窄屏对话浮层）不算", () => {
    const page = (matches: string[]) => ({ querySelector: (selector: string) => (selector.split(", ").some((part) => matches.includes(part)) ? {} : null) });
    expect(modalOpen(page(['[role="alertdialog"]']))).toBe(true);
    expect(modalOpen(page(["dialog[open]"]))).toBe(true);
    expect(modalOpen(page(['[role="dialog"][aria-modal="true"]:not([data-conversation-overlay])']))).toBe(true);
    expect(modalOpen(page(['[inert] [data-testid="global-controls"]']))).toBe(true);
    expect(modalOpen(page([]))).toBe(false);
    expect(modalOpen(null)).toBe(false);
  });
});
