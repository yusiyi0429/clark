"use client";

/**
 * 左侧阅读区此刻看哪一份（clark `detail-header/material-tabs.tsx`）。两样控件一起回答这一个问题，任何时刻恰好一个是当前：
 *
 * - `MaterialTabs`：页头下面一颗矮一点的细长胶囊，里面是这一页的材料页签。页签多了胶囊变长，少了变短，放不下时在
 *   自己里面横向滚动。它吸在页头下面，正文从它下面滚过去。
 * - `HeaderMaterialToggle`：页头胶囊右端一个「整场」的入口（会议页的会议记录）。它不属于任何一份材料，所以在页头里。
 *   按下去阅读区换成它，下面那排页签都不亮；再按一次回到刚才那份材料。
 *
 * 只换左侧看哪一份：不跳页、不改地址。
 */

import { useLayoutEffect, useRef } from "react";
import { ToggleButton, ToggleButtonGroup } from "ts-design/primitives";
import { FileText, NotebookPen } from "lucide-react";
import t from "@/styles/material-tabs.module.css";

export interface MaterialTab {
  id: string;
  /** 页签上的字：短名。 */
  label: string;
  /** 完整名：读屏读它，内容区的 aria-label 也用它。 */
  title: string;
}

/** 阅读区的选择：`current` 是此刻看的那一份；`material` 是最近看的那份材料，整场入口再按一次就回到它。 */
export interface MaterialView {
  current: string;
  material: string;
}

export const materialView = (material: string): MaterialView => ({ current: material, material });

/** 按下一份材料的页签：看它，也记住它。 */
export const pressMaterial = (view: MaterialView, id: string): MaterialView =>
  view.current === id && view.material === id ? view : { current: id, material: id };

/** 按页头那个整场入口：没在看就换成它；正在看就回到刚才那份材料。 */
export const toggleWhole = (view: MaterialView, wholeId: string): MaterialView =>
  view.current === wholeId ? { ...view, current: view.material } : { ...view, current: wholeId };

/**
 * 像浏览器页签那样，每一份各自记住滚到了哪儿：换过去从它上次的位置接着看，没看过的从头看。`key` 是
 * 「对象 | 这一份」；滚动容器是装着材料页签的那个阅读页（.ts-detail）。
 */
export function useRememberedScroll(key: string | undefined) {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (!key) return;
    const scroller = document.querySelector("[data-material-tabs]")?.closest<HTMLElement>(".ts-detail");
    if (!scroller) return;
    scroller.scrollTop = positions.current.get(key) ?? 0;
    const remember = () => positions.current.set(key, scroller.scrollTop);
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [key]);
}

export function MaterialTabs({
  tabs,
  selected,
  onSelect,
  label,
}: {
  tabs: MaterialTab[];
  /** 当前那份材料；整场入口是当前时为 null，一个都不亮。 */
  selected: string | null;
  onSelect: (id: string) => void;
  /** 整组的可访问名称，例如「会议材料」。 */
  label: string;
}) {
  return (
    <div className={t.bar} data-material-tabs data-count={tabs.length}>
      <ToggleButtonGroup
        aria-label={label}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={selected ? [selected] : []}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (typeof next === "string") onSelect(next);
        }}
      >
        {tabs.map((tab) => (
          <ToggleButton key={tab.id} id={tab.id} className={t.tab} aria-label={tab.title}>
            <FileText size={14} strokeWidth={1.8} aria-hidden />
            <span className={t.label}>{tab.label}</span>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </div>
  );
}

export function HeaderMaterialToggle({ tab, selected, onToggle }: { tab: MaterialTab; selected: boolean; onToggle: () => void }) {
  return (
    <ToggleButton className={t.whole} isSelected={selected} onChange={onToggle} data-header-whole aria-label={tab.title}>
      <NotebookPen size={16} strokeWidth={1.8} aria-hidden />
      <span className={t.label}>{tab.label}</span>
    </ToggleButton>
  );
}
