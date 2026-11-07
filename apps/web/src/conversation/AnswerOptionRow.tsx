"use client";

import type { KeyboardEvent } from "react";
import { chooseAnswerOption } from "./answerOptions";
import s from "@/styles/conversation-transcript.module.css";

/**
 * 最新一条回答下的一行轻量选项：点了只把「选择：{方案名}」填进输入框，不发送。
 * 新首页里画成选项框的选项行（带 1–9 序号）；焦点在这些选项上时，数字键和 ↑↓ 只移焦点，回车选（和选项框一样）。
 */
export function AnswerOptions({ scope, options }: { scope: string; options: string[] }) {
  if (!options.length) return null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    const to = digit >= 0 ? digit : event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : -1;
    if (to < 0 || to >= buttons.length) return;
    event.preventDefault();
    buttons[to]!.focus();
  };
  return (
    <div className={s.options} role="group" aria-label="可选方案" data-testid="answer-options" onKeyDown={onKeyDown}>
      {options.map((label, index) => (
        <button key={label} type="button" aria-keyshortcuts={index < 9 ? String(index + 1) : undefined} onClick={() => chooseAnswerOption(scope, label)}>{label}</button>
      ))}
    </div>
  );
}
