"use client";

/**
 * 听写时的一排控件：录音指示（红点呼吸 + 计时 0:12）· 弱化的声波（18 根淡灰）· ✕ 取消 · ■ 停下 · ↑ 直接发送。
 * 文字在输入框里（一直可见，边说边长、带下划线），这里只是辅助。
 * 首页输入条把 ✕ 放在左边那颗键里（showCancel=false）：[● 0:12 ▁▃▂▅▂] ■ ↑。
 * 二级页右列与事项群组是底行整行：左边指示 + 声波，右边 ✕ ■ ↑。
 * 收尾那一下（等识别 final、↑ 等整理），按下的那颗换成转圈、其余按不动。
 * 颜色读所在输入条的 --tone-*（二级页输入条）或 --dictation-*（首页输入条）。
 */

import { useState } from "react";
import { Button } from "ts-design/primitives";
import { ArrowUp, LoaderCircle, Square, X } from "lucide-react";
import { formatElapsed, type Dictation } from "./useDictation";
import s from "@/styles/dictation.module.css";

export function DictationControls({
  dictation,
  onToInput,
  onSend,
  canSend = true,
  showCancel = true,
}: {
  dictation: Dictation;
  /** ■：停下，文字留在输入框（不发送）。 */
  onToInput: () => Promise<void>;
  /** ↑：停下，等整理，直接发出去。 */
  onSend: () => Promise<void>;
  canSend?: boolean;
  showCancel?: boolean;
}) {
  const [pending, setPending] = useState<"input" | "send" | null>(null);
  const listening = dictation.phase === "listening";
  const finishing = dictation.phase === "finishing" || pending !== null;
  const run = (kind: "input" | "send", action: () => Promise<void>) => {
    if (pending) return;
    setPending(kind);
    void action().finally(() => setPending(null));
  };
  const spinner = <LoaderCircle size={16} strokeWidth={2} className={s.spin} />;
  const status = finishing ? (pending === "send" ? "正在整理并发送" : "正在收尾") : listening ? (dictation.live ? "正在听" : "正在录音，结束后转写") : "正在打开麦克风";
  return (
    <div className={s.controls} data-phase={dictation.phase} data-live={dictation.live}>
      <span className={s.meter} aria-hidden>
        <i className={s.dot} />
        <span className={s.clock}>{formatElapsed(dictation.elapsed)}</span>
        <span className={s.wave}>
          {dictation.levels.map((level, index) => (
            <i key={index} style={{ height: `${2 + Math.round(Math.min(1, level) * 8)}px` }} />
          ))}
        </span>
      </span>
      <span className={s.status} role="status">
        {status}
      </span>
      {showCancel ? (
        <Button isIconOnly className={s.button} data-kind="cancel" onPress={dictation.cancel} isDisabled={finishing} aria-label="取消听写">
          <X size={17} strokeWidth={2} />
        </Button>
      ) : null}
      <Button isIconOnly className={s.button} data-kind="stop" onPress={() => run("input", onToInput)} isDisabled={!listening || finishing} aria-label={pending === "input" ? "正在收尾" : "停止听写，文字留在输入框"}>
        {pending === "input" ? spinner : <Square size={13} strokeWidth={2.4} fill="currentColor" />}
      </Button>
      <Button isIconOnly className={s.button} data-kind="send" onPress={() => run("send", onSend)} isDisabled={!listening || finishing || !canSend} aria-label={pending === "send" ? "正在整理并发送" : "停止听写并直接发送"}>
        {pending === "send" ? spinner : <ArrowUp size={18} strokeWidth={2.2} />}
      </Button>
    </div>
  );
}
