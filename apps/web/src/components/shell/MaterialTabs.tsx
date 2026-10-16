"use client";

/**
 * 左侧阅读区此刻看哪一份（clark `detail-header/material-tabs.tsx`）。
 *
 * `MaterialMenu`：页头右边一颗按钮，写着此刻看的那一份；按下去是一张下拉单，列出这一页的材料，最后一项是「添加材料」。
 * 材料区要尽可能给材料留空间（用户 2026-09-29 定），所以不再在页头下面另起一排页签。二级页（DetailFrame）里它经
 * `HeaderSlot` 挂进页头；不在 DetailFrame 里的页就放在材料区自己那一行。
 * 页头另有类型切换（components/SegmentedSwitch：会议页的「会前预审 ｜ 会议记录」、议题页的「总结与判断 / 研究与依据」）时，
 * 切换的那几份不进下拉单；选了某份材料，切换里一段都不亮。
 *
 * 只换左侧看哪一份：不跳页、不改地址。
 */

import { createContext, Fragment, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import { Check, ChevronDown, FileText, Link2, Plus } from "lucide-react";
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
  /** 尚未开放的阅读视图仍可在菜单中说明，不允许切换。 */
  isDisabled?: boolean;
  hint?: string;
  /** 等本人采用 / 不采用的批注条数（只给能改这份材料的人），下拉钮上显示合计。 */
  count?: number;
  /** link：外部链接，图标换成链环。 */
  kind?: "document" | "link";
  /** Co-Agent 正在按批注改这一份：右侧写「在改」带脉冲点（盖过 hint）。 */
  working?: boolean;
  /** 这一项前面隔一条细线，线下写一小段字（执行事项完成后的「参考材料」）。 */
  ruleBefore?: string;
}

/** 下拉单最后的添加项：执行事项拆成上传文件 / 粘贴链接 / 起草文档三项（design-12），其余对象仍是一项「添加材料」。 */
export interface MaterialAddAction {
  id: string;
  label: string;
  icon: ReactNode;
  onPress: () => void;
}

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
  addActions,
  switchLabel = "切换材料",
}: {
  tabs: MaterialTab[];
  /** 当前那份材料；整场入口是当前时为 null，一项都不勾。 */
  selected: string | null;
  onSelect: (id: string) => void;
  /** 整组的可访问名称，例如「会议材料」。 */
  label: string;
  /** 有上传权限时才有：下拉单最后一项「添加材料」。 */
  onAdd?: () => void;
  /** 有它时代替「添加材料」，在细线下面列出这几项。 */
  addActions?: MaterialAddAction[];
  /** 复用到任务等阅读视图时使用该对象的切换名称。 */
  switchLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = tabs.find((tab) => tab.id === selected);
  const pending = tabs.reduce((sum, tab) => sum + (tab.count ?? 0), 0);
  const pick = (run: () => void) => { setOpen(false); run(); };
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button variant="ghost" className={t.trigger} data-material-menu
        aria-label={`${label}：${current ? `正在看 ${current.title}` : "没有在看材料"}${pending ? `，${pending} 条待处理` : ""}，${switchLabel}`}>
        {current?.kind === "link" ? <Link2 size={15} strokeWidth={1.8} aria-hidden /> : <FileText size={15} strokeWidth={1.8} aria-hidden />}
        <span className={t.label}>{current?.label ?? "材料"}</span>
        {pending ? <span className={t.count} aria-hidden>{pending}</span> : null}
        <ChevronDown size={14} strokeWidth={2} aria-hidden className={t.chevron} />
      </Button>
      <Popover.Content placement="bottom end" offset={6} className={t.popover}>
        <TianshuPortalTheme>
          <Popover.Dialog className={t.menu} aria-label={label}>
            {tabs.map((tab) => (
              <Fragment key={tab.id}>
                {tab.ruleBefore ? <p className={t.section}>{tab.ruleBefore}</p> : null}
                <Button variant="ghost" className={t.item}
                  aria-label={`${tab.title}${tab.working ? "（Co-Agent 修改中）" : ""}${tab.count ? `，${tab.count} 条待处理` : ""}`}
                  aria-current={tab.id === selected || undefined} isDisabled={tab.isDisabled}
                  onPress={() => { if (!tab.isDisabled) pick(() => onSelect(tab.id)); }}>
                  {tab.kind === "link" ? <Link2 size={15} strokeWidth={1.8} aria-hidden /> : <FileText size={15} strokeWidth={1.8} aria-hidden />}
                  <span className={t.label}>{tab.label}</span>
                  {tab.working ? <span className={`${t.hint} ${t.working}`}><span className={t.pulse} aria-hidden />修改中</span>
                    : tab.hint ? <span className={t.hint}>{tab.hint}</span> : null}
                  {tab.count ? <span className={t.count} aria-hidden>{tab.count}</span> : null}
                  {tab.id === selected ? <Check size={15} strokeWidth={2} aria-hidden className={t.check} /> : null}
                </Button>
              </Fragment>
            ))}
            {addActions?.length ? addActions.map((action, index) => (
              <Button key={action.id} variant="ghost" className={`${t.item} ${t.add}${index ? ` ${t.addNext}` : ""}`} onPress={() => pick(action.onPress)}>
                {action.icon}
                <span className={t.label}>{action.label}</span>
              </Button>
            )) : onAdd ? (
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
