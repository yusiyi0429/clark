import { describe, expect, it } from "vitest";
import { isWakeKey, modalOpen, startsWinHold } from "./wakeKey";

const key = (patch: Partial<Parameters<typeof isWakeKey>[0]>) => ({
  key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, ...patch,
});
const F13 = key({ key: "F13", code: "F13" });
const COMBO = key({ key: " ", code: "Space", ctrlKey: true, shiftKey: true, keyCode: 32 });
/** 按住微信语音键 Ctrl+Win：微信拦掉了 Ctrl，浏览器只收到 Win 按下（实测）。 */
const WIN = key({ key: "Meta", code: "MetaLeft", metaKey: true, keyCode: 91 });
const field = (inComposer: boolean) => ({ tagName: "TEXTAREA", isContentEditable: false, closest: (selector: string) => (inComposer && selector.includes("global-controls") ? {} : null) });

describe("唤醒键：F13 / Ctrl+Shift+Space", () => {
  it("两颗都算；只按 Ctrl+Space、多按了 Win 的不算", () => {
    expect(isWakeKey(F13, null)).toBe(true);
    expect(isWakeKey(COMBO, null)).toBe(true);
    expect(isWakeKey(key({ key: " ", code: "Space", ctrlKey: true, keyCode: 32 }), null)).toBe(false);
    expect(isWakeKey(key({ key: " ", code: "Space", ctrlKey: true, shiftKey: true, metaKey: true, keyCode: 32 }), null)).toBe(false);
  });

  it("按住不放的自动重复、输入法组词中都不算", () => {
    expect(isWakeKey({ ...COMBO, repeat: true }, null)).toBe(false);
    expect(isWakeKey({ ...COMBO, isComposing: true }, null)).toBe(false);
    expect(isWakeKey({ ...COMBO, key: "Process", keyCode: 229 }, null)).toBe(false);
  });
});

describe("按住 Win（微信语音键）", () => {
  it("Win 按下开始计时；Ctrl 没被拦住时一起按着也算", () => {
    expect(startsWinHold(WIN, null)).toBe(true);
    expect(startsWinHold({ ...WIN, ctrlKey: true }, null)).toBe(true);
    expect(startsWinHold({ ...WIN, key: "OS" }, null)).toBe(true);
  });

  it("自动重复、带 Alt、组词中、按的不是 Win：不开始", () => {
    expect(startsWinHold({ ...WIN, repeat: true }, null)).toBe(false);
    expect(startsWinHold({ ...WIN, altKey: true }, null)).toBe(false);
    expect(startsWinHold({ ...WIN, isComposing: true }, null)).toBe(false);
    expect(startsWinHold(key({ key: "Control", code: "ControlLeft", ctrlKey: true }), null)).toBe(false);
  });
});

describe("焦点在别的输入框里不抢（微信语音照常写进那个框）", () => {
  it("三种按法都不算；输入条自己的输入框、按钮上不算「别的」", () => {
    const contentEditable = { tagName: "DIV", isContentEditable: true, closest: () => null };
    expect(isWakeKey(F13, field(false))).toBe(false);
    expect(isWakeKey(COMBO, contentEditable)).toBe(false);
    expect(startsWinHold(WIN, field(false))).toBe(false);
    expect(isWakeKey(F13, field(true))).toBe(true);
    expect(startsWinHold(WIN, field(true))).toBe(true);
    expect(startsWinHold(WIN, { tagName: "BUTTON", closest: () => null })).toBe(true);
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
