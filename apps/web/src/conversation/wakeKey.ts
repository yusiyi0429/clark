"use client";

import { useEffect } from "react";
import { useStableCallback } from "./stableCallback";

/**
 * 唤醒输入框（外壳）：语音交给微信输入法，天枢只负责展开输入条、把光标放进输入框，说出来的字就落在这里。
 * 三种按法（配法见 .scratch/wechat-voice/AU05与微信语音输入配置.md）：
 * - F13、Ctrl+Shift+Space（macOS 同样是 Control，不用 Cmd）：给小键盘上单独一颗键，或「先唤醒、再开微信语音」的组合动作用；
 * - Windows 上微信的语音键 Ctrl+Win（按住说话，加 Shift 是免提）：按下那一刻就聚焦，微信紧跟着开始听。
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

/** Ctrl+Win（含免提的 Ctrl+Win+Shift）刚凑齐：只有修饰键，没有别的键（Ctrl+Win+→ 切桌面不算，那一下按的是箭头）。 */
function wechatVoiceChord(event: WakeKeyEvent): boolean {
  return event.ctrlKey && event.metaKey && !event.altKey && ["Control", "Meta", "OS", "Shift"].includes(event.key);
}

/** 这一下按键是不是唤醒。按住不放的自动重复不算；windows = 这台电脑是 Windows（Ctrl+Win 只在那里是微信的语音键）。 */
export function isWakeKey(event: WakeKeyEvent, active: FocusLike, windows: boolean): boolean {
  if (event.repeat || event.isComposing || event.keyCode === 229) return false;
  const explicit = event.key === WAKE_KEY || event.code === WAKE_KEY
    || (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && (event.code === "Space" || event.key === " " || event.key === "Spacebar"));
  if (!explicit && !(windows && wechatVoiceChord(event))) return false;
  return !otherEditableFocused(active);
}

/** 只有修饰键的那一种（微信的语音键）不挡默认行为：交给系统和微信。 */
export function keepsDefault(event: WakeKeyEvent): boolean {
  return wechatVoiceChord(event);
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
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isWakeKey(event, document.activeElement as FocusLike, windows) || modalOpen(document)) return;
      if (!keepsDefault(event)) event.preventDefault();
      wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wake]);
}
