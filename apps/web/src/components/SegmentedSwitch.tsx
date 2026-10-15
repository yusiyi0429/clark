"use client";

/**
 * 二级页的「类型切换」（用户 2026-10-11 定）：几个词并排，未选中的没有外框；选中的那一段是一颗胶囊（浅蓝底、深蓝字），
 * 各段各自成形、彼此切开，不是一整条滑块。首页顶部的「决策 / 战况」是标题式页签，不用它；筛选（全部 / 未读）也不用它。
 *
 * 读屏与键盘按单选组（radiogroup）：Tab 进到当前那一段（一段都没选时进第一段），方向键在各段间移动并选中，
 * Home / End 到头尾，空格或回车选中。`selected` 可以是 null（会议页正在看某份材料时，一段都不选）。
 */

import type { KeyboardEvent, ReactNode } from "react";
import s from "@/styles/segmented-switch.module.css";

export interface Segment<T extends string = string> {
  id: T;
  /** 段上的字（可带一个小图标）。 */
  label: ReactNode;
  /** 段上的字不够读屏读时（例如带图标的「战况」）给完整名。 */
  ariaLabel?: string;
}

/** 方向键、Home、End 之后落到第几段；别的键返回 null。左右、上下都按顺序走，到头绕回。 */
export function segmentKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function SegmentedSwitch<T extends string>({ label, segments, selected, onSelect, className, ...rest }: {
  /** 整组的读屏名称，例如「战场视角」。 */
  label: string;
  segments: Segment<T>[];
  /** 当前那一段；null：一段都不选。 */
  selected: T | null;
  onSelect: (id: T) => void;
  className?: string;
  [data: `data-${string}`]: string | undefined;
}) {
  const current = segments.findIndex((segment) => segment.id === selected);
  const focusable = current >= 0 ? current : 0;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = segmentKeyTarget(event.key, index, segments.length);
    if (target === null) return;
    event.preventDefault();
    // 焦点跟着选中走：同一组里第 target 颗（各段是这一组的直接子元素）。
    (event.currentTarget.parentElement?.children[target] as HTMLElement | undefined)?.focus();
    onSelect(segments[target].id);
  };
  return (
    <div role="radiogroup" aria-label={label} className={className ? `${s.switch} ${className}` : s.switch} data-segmented-switch="" {...rest}>
      {segments.map((segment, index) => {
        const on = segment.id === selected;
        return (
          <button
            key={segment.id}
            type="button"
            role="radio"
            className={s.segment}
            aria-checked={on}
            aria-label={segment.ariaLabel}
            tabIndex={index === focusable ? 0 : -1}
            data-selected={on || undefined}
            onClick={() => { if (!on) onSelect(segment.id); }}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
