"use client";

import { useEffect } from "react";
import { useStableCallback } from "./stableCallback";

/**
 * 唤醒输入框（外壳）：语音交给微信输入法，天枢只负责展开输入条、把光标放进输入框，说出来的字就落在这里。
 * 三种按法（配法见 .scratch/wechat-voice/AU05与微信语音输入配置.md）：
 * - F13、Ctrl+Shift+Space（macOS 同样是 Control，不用 Cmd）：给小键盘上单独一颗键，或「先唤醒、再开微信语音」的组合动作用；
 * - Windows 上按住微信的语音键 Ctrl+Win：微信在系统层把 Ctrl 拦掉，浏览器只看得到 Win，所以认「单独按住 Win 一小会儿」
 *   （WIN_HOLD_MS）。Win+E、截图这类快捷键在这之前就按了别的键，单按 Win 开开始菜单在这之前就松开了，都不算；也不拦这一下。
 * 焦点已在别的输入框里（会议页编辑框、批注框……）、输入法正在组词、有模态对话框开着时都不触发：不抢焦点，
 * 微信语音照常写进当时那个框。输入条（data-testid="global-controls"）自己的输入框不算「别的」。
 */
export const WAKE_KEY = "F13";

/** 单独按住 Win 多久算唤醒（微信语音是按住说话，远比这长）。 */
export const WIN_HOLD_MS = 300;

/** 当前页输入条里的输入框（首页输入条、右列私聊 / 群聊输入条，同一时刻只有一个）。 */
export const COMPOSER_FIELD = '[data-testid="global-controls"] textarea:not(:disabled)';

type WakeKeyEvent = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat" | "isComposing" | "keyCode">;
type FocusLike = { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null;

/** 焦点在输入条以外的可编辑区域里。 */
function otherEditableFocused(active: FocusLike): boolean {
  if (!active) return false;
  const editable = Boolean(active.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName ?? "");
  return editable && !active.closest?.('[data-testid="global-controls"]');
}

const isWin = (key: string) => key === "Meta" || key === "OS";
/**
 * 按住 Win 时不算「按了别的键」的：修饰键（微信免提的 Shift、没被拦住的 Ctrl），以及说不出名字的键——微信为了不让开始菜单
 * 弹出来，在 Win 按下后、松开前各补发一个（实测 keyCode 252，浏览器里是 Unidentified）。
 */
const keepsWinHold = (key: string) => isWin(key) || key === "Control" || key === "Shift" || key === "Alt" || key === "Unidentified";

/** 这一下是不是 F13 / Ctrl+Shift+Space。按住不放的自动重复、组词中不算。 */
export function isWakeKey(event: WakeKeyEvent, active: FocusLike): boolean {
  if (event.repeat || event.isComposing || event.keyCode === 229) return false;
  const explicit = event.key === WAKE_KEY || event.code === WAKE_KEY
    || (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && (event.code === "Space" || event.key === " " || event.key === "Spacebar"));
  return explicit && !otherEditableFocused(active);
}

/** 这一下是不是开始按住 Win（只在 Windows 上由调用方采用）：之后 WIN_HOLD_MS 内没松开、没按别的键才唤醒。 */
export function startsWinHold(event: WakeKeyEvent, active: FocusLike): boolean {
  if (!isWin(event.key) || event.repeat || event.altKey || event.isComposing) return false;
  return !otherEditableFocused(active);
}

/**
 * 模态对话框：role=dialog 且 aria-modal=true、确认框（alertdialog）、showModal 打开的原生 dialog，
 * 以及 React Aria 的弹窗（更新说明、约会议、导览）——它不写 aria-modal，而是把弹窗外的工作台整个设成 inert，输入条也在里面。
 * 我们自己的对话层不算：全局对话层（aria-modal=false），以及窄屏右列的对话浮层（aria-modal=true，带 data-conversation-overlay）。
 */
export const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]:not([data-conversation-overlay]), [role="alertdialog"], dialog[open], [inert] [data-testid="global-controls"]';

/** 页面上有没有开着的模态对话框。 */
export function modalOpen(root: Pick<Document, "querySelector"> | null | undefined): boolean {
  return Boolean(root?.querySelector(MODAL_SELECTOR));
}

/** 在 window 上接唤醒键。 */
export function useWakeKey(onWake: () => void) {
  const wake = useStableCallback(onWake);
  useEffect(() => {
    const windows = /Windows/i.test(navigator.userAgent);
    let hold: ReturnType<typeof setTimeout> | undefined;
    const cancelHold = () => {
      clearTimeout(hold);
      hold = undefined;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as FocusLike;
      if (windows && isWin(event.key)) {
        if (hold === undefined && startsWinHold(event, active) && !modalOpen(document)) {
          hold = setTimeout(() => {
            hold = undefined;
            // 这 0.3 秒里点进了别的输入框、开了弹窗：不动。
            if (!otherEditableFocused(document.activeElement as FocusLike) && !modalOpen(document)) wake();
          }, WIN_HOLD_MS);
        }
        return;
      }
      if (!keepsWinHold(event.key)) cancelHold();
      if (event.defaultPrevented || !isWakeKey(event, active) || modalOpen(document)) return;
      event.preventDefault();
      wake();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isWin(event.key)) cancelHold();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cancelHold();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [wake]);
}
