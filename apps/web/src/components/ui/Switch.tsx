"use client";

/**
 * 开关（设置里凡是开 / 关的地方，11/09 用户定：照 Claude 设置那种左右拨动的开关，不用勾选框）。
 * 整行是一个按钮（role="switch"、aria-checked），名字在左、轨道和圆钮在右；空格、回车都能切换。
 * 样子沿用引导里的轨道与圆钮（onboarding/foundation.module.css），尺寸缩到设置行用的 40×24：开是实心主色、圆钮在右，关是淡墨。
 * 多选（技能的工具、选同事）和「我确认…」这类确认勾选不是开关，不用它。
 */
import type { ReactNode } from "react";
import s from "./switch.module.css";

export function Switch({ checked, onChange, disabled, children, className, label, testId }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** 开关左边的内容（名字、小字）；整行都能点。 */
  children?: ReactNode;
  /** 换掉整行的样式（行距、字号跟着所在的页）；轨道和圆钮不变。 */
  className?: string;
  /** 没有 children 时的读屏名称。 */
  label?: string;
  testId?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={children ? undefined : label} disabled={disabled}
      className={className ? `${s.row} ${className}` : s.row} data-testid={testId} onClick={() => onChange(!checked)}>
      {children}
      <span className={s.track} data-on={checked || undefined} aria-hidden><span /></span>
    </button>
  );
}
