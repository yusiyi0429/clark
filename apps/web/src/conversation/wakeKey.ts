"use client";

import { useEffect } from "react";
import { useStableCallback } from "./stableCallback";
import { createGesture, gestureCode, HOLD_MS, readVoiceKeys, voiceBindings } from "./voiceKeys";

/**
 * 唤醒输入框（外壳）：语音交给微信输入法，天枢只负责展开输入条、把光标放进输入框，说出来的字就落在这里。
 * 两类按法：
 * - 本人录下的微信语音键（voiceKeys.ts：「按住说话」按住一小会儿、「启动语音输入」按一下）；Ulanzi 小键盘的语音键发的就是这两种之一。
 * - F13、Ctrl+Shift+Space（macOS 同样是 Control，不用 Cmd）：给小键盘上单独一颗键用（配法见 .scratch/wechat-voice/AU05与微信语音输入配置.md）。
 * 焦点已在别的输入框里（会议页编辑框、批注框……）、输入法正在组词、有模态对话框开着时都不触发：不抢焦点，
 * 微信语音照常写进当时那个框。输入条（data-testid="global-controls"）自己的输入框不算「别的」。
 */
export const WAKE_KEY = "F13";

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

/** 这一下是不是 F13 / Ctrl+Shift+Space。按住不放的自动重复、组词中不算。 */
export function isWakeKey(event: WakeKeyEvent, active: FocusLike): boolean {
  if (event.repeat || event.isComposing || event.keyCode === 229) return false;
  const explicit = event.key === WAKE_KEY || event.code === WAKE_KEY
    || (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && (event.code === "Space" || event.key === " " || event.key === "Spacebar"));
  return explicit && !otherEditableFocused(active);
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

/** 在 window 上接唤醒键：每次手势开始时读一次录下的键（面板里刚录的马上生效）。 */
export function useWakeKey(onWake: () => void) {
  const wake = useStableCallback(onWake);
  useEffect(() => {
    const windows = /Windows/i.test(navigator.userAgent);
    const gesture = createGesture();
    let binds = voiceBindings(readVoiceKeys(), windows);
    let hold: ReturnType<typeof setTimeout> | undefined;
    const cancelHold = () => {
      clearTimeout(hold);
      hold = undefined;
    };
    const blocked = () => otherEditableFocused(document.activeElement as FocusLike) || modalOpen(document);
    const onKeyDown = (event: KeyboardEvent) => {
      const code = event.repeat ? null : gestureCode(event);
      if (code) {
        if (gesture.idle()) binds = voiceBindings(readVoiceKeys(), windows);
        if (event.isComposing || blocked()) gesture.spoil();
        if (!gesture.down(code, event.timeStamp, binds)) cancelHold();
        else if (hold === undefined) {
          hold = setTimeout(() => {
            hold = undefined;
            // 这 0.3 秒里点进了别的输入框、开了弹窗：不动。
            if (!gesture.holding(binds) || blocked()) return;
            gesture.fire();
            wake();
          }, HOLD_MS);
        }
      }
      if (event.defaultPrevented || !isWakeKey(event, document.activeElement as FocusLike) || modalOpen(document)) return;
      event.preventDefault();
      wake();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const code = gestureCode(event);
      if (!code) return;
      cancelHold();
      if (gesture.up(code, event.timeStamp, binds) && !blocked()) wake();
    };
    // 按着 Ctrl 点鼠标、滚轮缩放：不是语音键。
    const spoil = () => {
      gesture.spoil();
      cancelHold();
    };
    const reset = () => {
      gesture.reset();
      cancelHold();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", spoil, true);
    window.addEventListener("wheel", spoil, { capture: true, passive: true });
    window.addEventListener("blur", reset);
    return () => {
      reset();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", spoil, true);
      window.removeEventListener("wheel", spoil, true);
      window.removeEventListener("blur", reset);
    };
  }, [wake]);
}
