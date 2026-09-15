"use client";

import type { KeyboardEvent } from "react";
import { useRef } from "react";

import { cn } from "@/lib/utils";

export type Space = "issues" | "deployed";

const OPTIONS: { value: Space; label: string }[] = [
  { value: "issues", label: "议题" },
  { value: "deployed", label: "已部署" },
];

/**
 * 「战略议题 / 已部署」这两屏之间的切换，坐在中栏标题原来 `<h2>议题</h2>` 的位置上。
 *
 * ## 它替下的是两颗点，不是那句标题
 *
 * 上一版（`deployed-rail.tsx`，现已删除）把这个入口做成中栏左缘常驻的两颗点：收起来
 * 只是两个小圆点、不占字面，因为那时标题那一排已经被「议题」两个字占着，容不下第二样
 * 东西——**那两个字此刻只是一句静态的报幕，谁都不点它**，于是入口只能另找地方挤，
 * 挤到左缘之后又要面对「点太小不好点」「命中区会不会盖住别的东西」这些麻烦事。
 *
 * 现在反过来：这个开关**直接顶替**了那句报幕，而不是在它边上再插一个东西。标题那一排
 * 本来就有一块专门空出来、谁都不用的位置，把开关摆在那儿是零新增面积——不像两颗点
 * 那样，是在一块已经被填满的版面上再抠一块出来。所以它可以完全常驻可见、不用再靠
 * 悬停展开：常驻的代价在这一版里已经被"标题反正也没用"这件事免掉了。
 *
 * ## 仍然只有两格，不做成 `options: {value,label}[]` 的通用组件
 *
 * 这一条论证是从旧版原样搬过来的，结论没有变：此刻真的只有两屏，`Space` 类型也只有
 * 两个字面量。为一个还不存在的第三屏先把它写成任意长度的数组，换回来的是一个此刻就
 * 答不圆的接口——数组长度一旦大于二，「滑块」这个视觉隐喻本身就要重新设计（三格还能
 * 叫"滑"吗），不是加一个 `options` 参数就能长大的。真到那一天再重写这个组件，比现在
 * 猜一个通用形状更便宜。
 *
 * ## 为什么只有「已部署」那一格带数字
 *
 * 「议题」那一格此刻显示的就是中栏这一整份清单，数字摆在眼前不用再数一遍；「已部署」
 * 切走之后才看得见，屏幕上唯一能替他先算好的只有这一个数。两格对称地各来一个数字，
 * 会让人以为两个数字是同一件事的两种口径（这一屏错过一次数，另一边那个数也不再可信），
 * 而它们其实来自完全不同的两次筛选。这一条也是从旧版搬过来的，理由没有变，只是从
 * 「两行文字」的版式换成了「两个按钮」的版式。
 *
 * ## 键盘行为照抄座位滑块（`src/app/access/access-form.tsx`）
 *
 * `role="radiogroup"` 配真正的 roving tabIndex + 方向键：组里只有当前选中的那一格是
 * Tab 停靠点，方向键切换选中项时把 DOM 焦点也带着走。原因和那边完全一样——`role`
 * 只买到"念出来像单选组"，方向键能不能用得自己写，两件事分开做，屏幕阅读器和键盘
 * 用户听到的、按到的才是同一件事。
 */
export function SpaceSwitch({
  value,
  onChange,
  deployedCount,
}: {
  value: Space;
  onChange: (next: Space) => void;
  deployedCount: number;
}) {
  const optionRefs = useRef<Record<Space, HTMLButtonElement | null>>({
    issues: null,
    deployed: null,
  });

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = OPTIONS.findIndex((option) => option.value === value);
    let nextIndex: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + OPTIONS.length) % OPTIONS.length;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % OPTIONS.length;
    } else {
      return;
    }

    event.preventDefault();
    const next = OPTIONS[nextIndex].value;
    onChange(next);
    optionRefs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="战略议题与已部署"
      onKeyDown={handleKeyDown}
      className="relative inline-grid grid-cols-2 rounded-full border border-hairline bg-list-ground p-[3px]"
    >
      {/*
       * 会滑的底，一整块，不是给选中那一格加背景——加背景是"一格灭、另一格亮"，读起来
       * 是两个开关；这里要说的是同一个东西从左边挪到了右边。做法和 `.seatThumb` 一样：
       * 绝对定位、宽度固定为一半、靠 `translate-x-full` 移动，而不是靠 `left` 或
       * `grid-column` 去改它在网格里的位置——后者会让它在移动的两端各自触发一次布局，
       * 前者是单纯的合成层动画。
       */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-full bg-surface shadow-e2",
          "transition-transform duration-[var(--dur-base)] ease-brand",
          value === "deployed" && "translate-x-full",
        )}
      />
      {OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              optionRefs.current[option.value] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative z-10 whitespace-nowrap rounded-full px-3 py-1 text-sm transition-colors duration-[var(--dur-fast)]",
              active ? "font-medium text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            {option.label}
            {option.value === "deployed" && (
              <span className="ml-1.5 tabular-nums text-ink-faint">{deployedCount}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
