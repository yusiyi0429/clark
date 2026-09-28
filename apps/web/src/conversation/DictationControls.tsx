"use client";

/**
 * 听写时的一排控件（照 ChatGPT 的听写）：✕ 取消 · 撑满中间、随音量跳动的点 · ■ 停下并把文字放进输入框 · ↑ 直接发送。
 * 首页输入条把 ✕ 放在左边那颗键里（showCancel=false）。转文字那一两秒，按下的那颗换成转圈、其余按不动。
 * 颜色读所在输入条的 --tone-*（二级页输入条）或 --dictation-*（首页输入条）。
 */

import { useState } from "react";
import { Button } from "ts-design/primitives";
import { ArrowUp, LoaderCircle, Square, X } from "lucide-react";
import type { Dictation } from "./useDictation";
import s from "@/styles/dictation.module.css";

export function DictationControls({
  dictation,
  onToInput,
  onSend,
  canSend = true,
  showCancel = true,
}: {
  dictation: Dictation;
  /** ■：停下，转好的文字放进输入框（不发送）。 */
  onToInput: () => Promise<void>;
  /** ↑：停下，转好的文字直接发出去。 */
  onSend: () => Promise<void>;
  canSend?: boolean;
  showCancel?: boolean;
}) {
  const [pending, setPending] = useState<"input" | "send" | null>(null);
  const listening = dictation.phase === "listening";
  const transcribing = dictation.phase === "transcribing";
  const run = (kind: "input" | "send", action: () => Promise<void>) => {
    setPending(kind);
    void action().finally(() => setPending(null));
  };
  const spinner = <LoaderCircle size={16} strokeWidth={2} className={s.spin} />;
  return (
    <div className={s.controls} data-phase={dictation.phase}>
      {showCancel ? (
        <Button isIconOnly className={s.button} data-kind="cancel" onPress={dictation.cancel} isDisabled={transcribing} aria-label="取消听写">
          <X size={17} strokeWidth={2} />
        </Button>
      ) : null}
      <span className={s.dots} aria-hidden>
        {dictation.levels.map((level, index) => (
          <i key={index} style={{ height: `${3 + Math.round(level * 18)}px` }} />
        ))}
      </span>
      <span className={s.status} role="status">
        {transcribing ? "正在转成文字" : listening ? "正在听" : ""}
      </span>
      <Button isIconOnly className={s.button} data-kind="stop" onPress={() => run("input", onToInput)} isDisabled={!listening} aria-label={pending === "input" ? "正在转成文字" : "停止，转成文字放进输入框"}>
        {pending === "input" ? spinner : <Square size={13} strokeWidth={2.4} fill="currentColor" />}
      </Button>
      <Button isIconOnly className={s.button} data-kind="send" onPress={() => run("send", onSend)} isDisabled={!listening || !canSend} aria-label={pending === "send" ? "正在转成文字并发送" : "转成文字直接发送"}>
        {pending === "send" ? spinner : <ArrowUp size={18} strokeWidth={2.2} />}
      </Button>
    </div>
  );
}
