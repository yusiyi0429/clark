"use client";

import { useImperativeHandle, useRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import a from "@/styles/access.module.css";

export type PinFieldHandle = { clear: (focus?: boolean) => void; focus: () => void; value: () => string };

/** 逐位数字格（clark `access-form` 的访问码格子）：输满自动回调，支持粘贴、左右键与退格回退；输入显示为圆点。 */
export function PinField({
  ref,
  length = 4,
  label,
  disabled,
  invalid,
  autoFocus,
  autoComplete = "off",
  describedBy,
  onComplete,
}: {
  ref?: Ref<PinFieldHandle>;
  length?: number;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  describedBy?: string;
  onComplete: (code: string) => void;
}) {
  const digits = useRef<string[]>(Array(length).fill(""));
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  const focusAt = (index: number) => inputs.current[Math.max(0, Math.min(index, length - 1))]?.focus();
  const firstEmpty = () => {
    const index = digits.current.findIndex((digit) => !digit);
    return index === -1 ? length - 1 : index;
  };

  useImperativeHandle(ref, () => ({
    clear(focus = true) {
      digits.current = Array(length).fill("");
      inputs.current.forEach((input) => {
        if (input) input.value = "";
      });
      if (focus) requestAnimationFrame(() => focusAt(0));
    },
    focus: () => focusAt(firstEmpty()),
    value: () => digits.current.join(""),
  }));

  function apply(start: number, value: string) {
    const incoming = value.replace(/\D/g, "").slice(0, length - start);
    if (!incoming) return;
    const next = [...digits.current];
    incoming.split("").forEach((digit, offset) => {
      next[start + offset] = digit;
    });
    digits.current = next;
    next.forEach((digit, index) => {
      const input = inputs.current[index];
      if (input) input.value = digit;
    });
    // 先完成本组焦点移动，再交给 onComplete；不能延后抢回「确认口令」的焦点。
    focusAt(Math.min(start + incoming.length, length - 1));
    const code = next.join("");
    if (code.length === length) onComplete(code);
  }

  function onChange(index: number, event: ChangeEvent<HTMLInputElement>) {
    if (event.target.value) {
      apply(index, event.target.value);
      return;
    }
    const next = [...digits.current];
    next[index] = "";
    digits.current = next;
  }

  function onPaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/\d/.test(pasted)) return;
    event.preventDefault();
    apply(index, pasted);
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      apply(index, event.key);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "Backspace" && !digits.current[index] && index > 0) {
      event.preventDefault();
      const next = [...digits.current];
      next[index - 1] = "";
      digits.current = next;
      const previous = inputs.current[index - 1];
      if (previous) previous.value = "";
      focusAt(index - 1);
    }
  }

  return (
    <div className={`${a.codeField} ${invalid ? a.codeFieldError : ""}`} data-length={length} role="group" aria-label={label}>
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(node) => {
            inputs.current[index] = node;
          }}
          aria-label={`${label}第 ${index + 1} 位`}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={index === 0 ? autoComplete : "off"}
          autoFocus={autoFocus && index === 0}
          maxLength={1}
          defaultValue=""
          placeholder=" "
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(index, event)}
          onPaste={(event) => onPaste(index, event)}
          onKeyDown={(event) => onKeyDown(index, event)}
          className={a.codeCell}
        />
      ))}
    </div>
  );
}
