"use client";

import { chooseAnswerOption } from "./answerOptions";
import s from "@/styles/conversation-transcript.module.css";

/** 最新一条回答下的一行轻量选项：点了只把「选择：{方案名}」填进输入框，不发送。 */
export function AnswerOptions({ scope, options }: { scope: string; options: string[] }) {
  if (!options.length) return null;
  return (
    <div className={s.options} role="group" aria-label="可选方案" data-testid="answer-options">
      {options.map((label) => (
        <button key={label} type="button" onClick={() => chooseAnswerOption(scope, label)}>{label}</button>
      ))}
    </div>
  );
}
