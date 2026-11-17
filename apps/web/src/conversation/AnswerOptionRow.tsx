"use client";

import { createContext, type KeyboardEvent } from "react";
import { chooseAnswerOption } from "./answerOptions";
import type { Message } from "./useConversation";
import s from "@/styles/conversation-transcript.module.css";
import b from "@/styles/conversation-bubbles.module.css";

/** 新首页的两种对话（WorkTimeline）给：最新一条回答是哪条、选项点了怎么发。这条回答把选项画成最后一个气泡下面的一排小胶囊（设计 6.4）。 */
export const QuickReplyContext = createContext<{ message: Message; send: (text: string) => void } | null>(null);

/**
 * 最新一条回答下的一行轻量选项：点了只把「选择：{方案名}」填进输入框，不发送。
 * 给了 send（新首页的伙伴主线、项目对话）：画成一排小胶囊，点了直接把选项的字作为本人的话发出去。
 * 新首页里画成选项框的选项行（带 1–9 序号）；焦点在这些选项上时，数字键和 ↑↓ 只移焦点，回车选（和选项框一样）。
 */
export function AnswerOptions({ scope, options, send }: { options: string[] } & ({ scope: string; send?: never } | { send: (text: string) => void; scope?: never })) {
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
    <div className={send ? b.pills : s.options} data-pills={send ? "" : undefined} role="group" aria-label="可选方案" data-testid="answer-options" onKeyDown={onKeyDown}>
      {options.map((label, index) => (
        <button key={label} type="button" aria-keyshortcuts={index < 9 ? String(index + 1) : undefined} onClick={() => (send ? send(label) : chooseAnswerOption(scope!, label))}>{label}</button>
      ))}
    </div>
  );
}
