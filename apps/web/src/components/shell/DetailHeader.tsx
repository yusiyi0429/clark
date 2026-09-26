"use client";

import type { ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import { ContextMark, type ContextMarkKind } from "@/components/ContextMark";
import { HeroButton } from "@/components/HeroButton";
import { useWorkspace } from "./WorkspaceContext";
import s from "@/styles/app-shell.module.css";

/**
 * 展开页页头（clark `workspace.tsx:592` 的 expandedHeader）：玻璃渐变、ContextMark、眉题 + 标题，
 * 或眉题 + 「返回…」键（信号详情），右侧圆形关闭（data-close-view：打开时外壳把焦点放在这里）。
 */
export function DetailHeader({
  mark,
  eyebrow,
  title,
  back,
  extra,
  actions,
  closeLabel,
  onClose,
}: {
  mark?: ContextMarkKind;
  eyebrow: string;
  title?: ReactNode;
  /** 有它时标题位换成返回键（clark 信号详情：`返回信号列表`）。 */
  back?: { label: string; onPress: () => void };
  /** 标题后面同一行的控件（clark 战场视角切换）。 */
  extra?: ReactNode;
  /** 关闭键左边的页头动作。 */
  actions?: ReactNode;
  closeLabel: string;
  onClose: () => void;
}) {
  const { closing } = useWorkspace();
  return (
    <header className={s.expandedHeader}>
      <div className={s.expandedIdentity}>
        {mark ? <ContextMark kind={mark} /> : null}
        <div>
          <span>{eyebrow}</span>
          {back ? (
            <HeroButton variant="ghost" size="sm" type="button" className={s.backToList} data-radar-back onPress={back.onPress}>
              <ChevronLeft size={19} aria-hidden="true" />
              {back.label}
            </HeroButton>
          ) : (
            <h1>{title}</h1>
          )}
        </div>
        {extra}
      </div>
      {actions}
      <HeroButton variant="ghost" size="sm" isIconOnly data-close-view onPress={onClose} className={s.closeRound} aria-label={closeLabel} isDisabled={closing}>
        <X size={23} aria-hidden="true" />
      </HeroButton>
    </header>
  );
}
