"use client";

/**
 * 左栏标题被截断时的完整名字：鼠标停在这一行约 500ms、或键盘把焦点移到这一行，出站内统一的提示（HeroUI Tooltip，不用原生 title）；
 * 移开、失焦、按下就收。没截断不出。手机上没有悬停（只认鼠标指针），不出。
 */
import { useEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { Tooltip } from "@heroui/react";
import h from "@/styles/home.module.css";

export const NAME_TIP_MS = 500;

/** 文字比它的框宽（被省略号截断了）。 */
export const isTruncated = (element: { scrollWidth: number; clientWidth: number } | null) => !!element && element.scrollWidth > element.clientWidth;

/** 进来时看一眼截没截断，截断了 ms 后 setOpen(true)；出去就收。 */
export function nameTip(truncated: () => boolean, setOpen: (open: boolean) => void, ms = NAME_TIP_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const leave = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    setOpen(false);
  };
  const enter = () => {
    leave();
    if (truncated()) timer = setTimeout(() => setOpen(true), ms);
  };
  return { enter, leave };
}

/** textRef 挂在会截断的那段字上，rowProps 挂在这一行（按钮）上，tip 放在行里（浮层走 portal）。detail：名字下面再一行（子会话的「来源 · 模型」）。 */
export function useNameTip(name: string, detail?: string | null) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [tip] = useState(() => nameTip(() => isTruncated(textRef.current), setOpen));
  useEffect(() => tip.leave, [tip]);
  const rowProps = {
    onPointerEnter: (event: PointerEvent) => { if (event.pointerType === "mouse") tip.enter(); },
    onPointerLeave: tip.leave,
    onPointerDown: tip.leave,
    onFocus: (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(":focus-visible")) tip.enter(); },
    onBlur: tip.leave,
  };
  // 开关由这里管（isOpen 放在外层，定位跟着它算），浮层挂在那段字上（triggerRef）。
  const node = open ? (
    <Tooltip isOpen onOpenChange={(next) => { if (!next) tip.leave(); }}>
      <Tooltip.Content triggerRef={textRef} placement="right">{name}{detail ? <span className={h.tipDetail}>{detail}</span> : null}</Tooltip.Content>
    </Tooltip>
  ) : null;
  return { textRef, rowProps, tip: node };
}
