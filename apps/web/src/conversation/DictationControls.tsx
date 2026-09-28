"use client";

/**
 * 听写时输入条右下角那一组（照 Claude 的听写）：一排随音量跳动的点，✕ 丢掉，✓ 转成文字。
 * 转文字那一两秒 ✓ 换成转圈、两颗都按不动。颜色读所在输入条的 --tone-*（二级页输入条）或 --dictation-*（首页输入条）。
 */

import { Button } from "ts-design/primitives";
import { Check, LoaderCircle, X } from "lucide-react";
import type { Dictation } from "./useDictation";
import s from "@/styles/dictation.module.css";

export function DictationControls({ dictation, onConfirm }: { dictation: Dictation; onConfirm: () => void }) {
  const transcribing = dictation.phase === "transcribing";
  return (
    <div className={s.controls} data-phase={dictation.phase}>
      <span className={s.dots} aria-hidden>
        {dictation.levels.map((level, index) => (
          <i key={index} style={{ height: `${3 + Math.round(level * 18)}px` }} />
        ))}
      </span>
      <span className={s.status} role="status">
        {transcribing ? "正在转成文字" : dictation.phase === "listening" ? "正在听" : ""}
      </span>
      <Button isIconOnly className={s.button} data-kind="cancel" onPress={dictation.cancel} isDisabled={transcribing} aria-label="不要这段，取消听写">
        <X size={16} strokeWidth={2} />
      </Button>
      <Button isIconOnly className={s.button} data-kind="confirm" onPress={onConfirm} isDisabled={dictation.phase !== "listening"} aria-label={transcribing ? "正在转成文字" : "说完了，转成文字"}>
        {transcribing ? <LoaderCircle size={16} strokeWidth={2} className={s.spin} /> : <Check size={16} strokeWidth={2.2} />}
      </Button>
    </div>
  );
}
