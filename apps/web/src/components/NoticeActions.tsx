"use client";

/**
 * 通知卡上的处理（clark `dri/notice-actions.tsx`）：像飞书消息卡片那样，在卡上就能办完，不必点进去。
 *
 * - 主按钮一点就办（接下、知道了、确认、不同意）。
 * - 要写原因的那一个（退回）先展开一小块填写区，写了原因才能提交。
 * - 办成了，这条从通知栏退掉，原位写一行回执（`onSettled`）；失败时输入留着，写明原因（C-04）。
 *
 * 这一块是标题行的兄弟节点，不嵌在打开详情的按钮里 —— 交互控件不套交互控件。
 */

import { useRef, useState, type KeyboardEvent } from "react";
import { Button, Label, TextArea, TextField } from "ts-design/primitives";
import a from "@/styles/notice-actions.module.css";

export type NoticeOutcome = { ok: true; settled?: string } | { ok: false; error: string };

export interface NoticeButton {
  label: string;
  /** 主动作：实心一点。 */
  emphasis?: boolean;
  run: () => Promise<NoticeOutcome>;
}

export interface NoticeReason {
  label: string;
  fieldLabel: string;
  placeholder: string;
  submitLabel: string;
  /** 填写区展开时预先填好的内容（「改一下」从原说法改起）。 */
  initial?: string;
  run: (reason: string) => Promise<NoticeOutcome>;
}

export function NoticeActions({
  title,
  buttons,
  reason,
  onSettled,
}: {
  /** 读屏用：「处理：…」。 */
  title: string;
  buttons: NoticeButton[];
  /** 要写原因的那一个（退回）。 */
  reason?: NoticeReason;
  onSettled: (text?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(reason?.initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);

  const apply = async (run: () => Promise<NoticeOutcome>) => {
    setBusy(true);
    setError(undefined);
    const outcome = await run().catch((): NoticeOutcome => ({ ok: false, error: "操作未完成：网络连接中断，请重试。" }));
    setBusy(false);
    if (!outcome.ok) return setError(outcome.error);
    setOpen(false);
    onSettled(outcome.settled);
  };

  /** 收起填写区，焦点回到打开它的那颗按钮上。 */
  const close = () => {
    setOpen(false);
    setError(undefined);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-mode="reason"]')?.focus());
  };

  /** Escape 先收起填写区（不关页面、不收通知栏）；中文组词时不处理。 */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  return (
    <div ref={root} className={a.handle} role="group" aria-label={`处理：${title}`} onKeyDown={onKeyDown}>
      <div className={a.actions}>
        {buttons.map((button) => (
          <Button key={button.label} variant="ghost" size="sm" data-emphasis={button.emphasis || undefined} isDisabled={busy} onPress={() => void apply(button.run)}>
            {button.label}
          </Button>
        ))}
        {reason ? (
          <Button variant="ghost" size="sm" data-mode="reason" aria-expanded={open} isDisabled={busy} onPress={() => (open ? close() : setOpen(true))}>
            {reason.label}
          </Button>
        ) : null}
      </div>
      {open && reason ? (
        <div className={a.form}>
          <TextField className={a.field} value={text} onChange={setText} autoFocus>
            <Label className={a.fieldLabel}>{reason.fieldLabel}</Label>
            <TextArea rows={2} placeholder={reason.placeholder} />
          </TextField>
          <div className={a.formActions}>
            <Button variant="ghost" size="sm" onPress={close}>
              取消
            </Button>
            <Button variant="ghost" size="sm" data-emphasis isDisabled={busy || !text.trim() || text.trim() === reason.initial?.trim()} onPress={() => void apply(() => reason.run(text.trim()))}>
              {reason.submitLabel}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className={a.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
