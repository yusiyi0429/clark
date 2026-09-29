"use client";

/**
 * 左侧阅读区此刻看哪一份（clark `detail-header/material-tabs.tsx`）。两样控件一起回答这一个问题，任何时刻恰好一个是当前：
 *
 * - `MaterialMenu`：页头右边一颗按钮，写着此刻看的那一份；按下去是一张下拉单，列出这一页的材料，最后一项是「添加材料」。
 *   材料区要尽可能给材料留空间（用户 2026-09-29 定），所以不再在页头下面另起一排页签。二级页（DetailFrame）里它经
 *   `HeaderSlot` 挂进页头；没有 DetailFrame 的页（议题页）就放在材料区自己那一行。
 * - `HeaderMaterialToggle`：页头右端一个「整场」的入口（会议页的会议记录）。它不属于任何一份材料，所以单独一颗。
 *   按下去阅读区换成它，下拉单里一项都不勾；再按一次回到刚才那份材料。
 *
 * 只换左侧看哪一份：不跳页、不改地址。
 */

import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover, ToggleButton } from "ts-design/primitives";
import { Check, ChevronDown, FileText, NotebookPen, Plus } from "lucide-react";
import t from "@/styles/material-tabs.module.css";

/**
 * 页头里留给材料下拉单的那一格。`null`：不在 DetailFrame 里，下拉单放在材料区自己那一行；`{ element: null }`：在页头里，
 * 但那一格还没挂上（服务端渲染、第一次提交前），先不画，免得先在正文里闪一下再跳到页头。
 */
export const HeaderSlot = createContext<{ element: HTMLElement | null } | null>(null);

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
 * 「对象 | 这一份」；滚动容器是装着材料区的那个阅读页（.ts-detail），没有就是材料区自己的阅读框。
 */
export function useRememberedScroll(key: string | undefined) {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (!key) return;
    const scroller = document.querySelector("[data-material-scope]")?.closest<HTMLElement>(".ts-detail")
      ?? document.querySelector<HTMLElement>("[data-material-scroll]");
    if (!scroller) return;
    scroller.scrollTop = positions.current.get(key) ?? 0;
    const remember = () => positions.current.set(key, scroller.scrollTop);
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [key]);
}

export function MaterialMenu({
  tabs,
  selected,
  onSelect,
  label,
  onAdd,
}: {
  tabs: MaterialTab[];
  /** 当前那份材料；整场入口是当前时为 null，一项都不勾。 */
  selected: string | null;
  onSelect: (id: string) => void;
  /** 整组的可访问名称，例如「会议材料」。 */
  label: string;
  /** 有上传权限时才有：下拉单最后一项「添加材料」。 */
  onAdd?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = tabs.find((tab) => tab.id === selected);
  const pick = (run: () => void) => { setOpen(false); run(); };
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button variant="ghost" className={t.trigger} data-material-menu
        aria-label={`${label}：${current ? `正在看 ${current.title}` : "没有在看材料"}，切换材料`}>
        <FileText size={15} strokeWidth={1.8} aria-hidden />
        <span className={t.label}>{current?.label ?? "材料"}</span>
        <ChevronDown size={14} strokeWidth={2} aria-hidden className={t.chevron} />
      </Button>
      <Popover.Content placement="bottom end" offset={6} className={t.popover}>
        <TianshuPortalTheme>
          <Popover.Dialog className={t.menu} aria-label={label}>
            {tabs.map((tab) => (
              <Button key={tab.id} variant="ghost" className={t.item} aria-label={tab.title} aria-current={tab.id === selected || undefined}
                onPress={() => pick(() => onSelect(tab.id))}>
                <FileText size={15} strokeWidth={1.8} aria-hidden />
                <span className={t.label}>{tab.label}</span>
                {tab.id === selected ? <Check size={15} strokeWidth={2} aria-hidden className={t.check} /> : null}
              </Button>
            ))}
            {onAdd ? (
              <Button variant="ghost" className={`${t.item} ${t.add}`} onPress={() => pick(onAdd)}>
                <Plus size={15} strokeWidth={2} aria-hidden />
                <span className={t.label}>添加材料</span>
              </Button>
            ) : null}
          </Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  );
}

/** 页头里的一格装材料下拉单；在页头里就挂过去，不在就原地画。 */
export function InHeader({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  if (!slot) return <>{children}</>;
  return slot.element ? createPortal(children, slot.element) : null;
}

export function HeaderMaterialToggle({ tab, selected, onToggle }: { tab: MaterialTab; selected: boolean; onToggle: () => void }) {
  return (
    <ToggleButton className={t.whole} isSelected={selected} onChange={onToggle} data-header-whole aria-label={tab.title}>
      <NotebookPen size={16} strokeWidth={1.8} aria-hidden />
      <span className={t.label}>{tab.label}</span>
    </ToggleButton>
  );
}
