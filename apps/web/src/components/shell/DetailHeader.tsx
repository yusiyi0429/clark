"use client";

import { useContext, type ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import { ContextMark, type ContextMarkKind } from "@/components/ContextMark";
import { HeroButton } from "@/components/HeroButton";
import { WorkspaceContext } from "./WorkspaceContext";
import s from "@/styles/app-shell.module.css";

/**
 * 展开页页头（clark `workspace.tsx:592` 的 expandedHeader）：玻璃渐变、ContextMark、眉题 + 标题，
 * 或眉题 + 「返回…」键（信号详情），右侧圆形关闭（data-close-view：打开时外壳把焦点放在这里）。
 * 手机上这颗键挪到左上角、换成返回箭头（app-shell.module.css ≤599），和任务卡、会议页的返回同一个位置。
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
  // 不在工作区外壳里时（例如单独渲染的成员页）没有关闭中的状态。
  const closing = useContext(WorkspaceContext)?.closing ?? false;
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
        <X size={23} aria-hidden="true" className={s.closeIcon} />
        <ChevronLeft size={26} aria-hidden="true" className={s.backIcon} />
      </HeroButton>
    </header>
  );
}
