"use client";

/**
 * 二级页的阅读页与页头（clark `detail-header/frame.tsx`，C-08）：天枢没有 ts-design WorkspaceShell，用它画出和
 * WorkspaceShell 详情同一个 DOM —— 阅读页 `.ts-detail` 里吸顶一个 `header.ts-detail-header`，里面 `.ts-row`（返回 +
 * 材料下拉单那一格 + actions）、`p.ts-eyebrow`、`h1`。页头的样子全在 header-capsule.module.css 的 scope 上，认的就是这几个类名。
 * 材料区（ObjectMaterialArea）的下拉单经 HeaderSlot 挂进 `data-header-tools` 那一格。
 *
 * 外面包一层 TianshuTheme：字体、颜色和 HeroUI 的主题变量同源。新首页外壳里跟外观（深色时套深色，见 frameScheme），老页面照旧亮色。宿主只管外框 —— 位置、圆角、和右列接上；
 * 阅读页铺满它、跟着它的圆角走。返回键带 `data-close-view`：打开时外壳把焦点放在这里。
 */

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { TianshuTheme } from "ts-design";
import { Button } from "ts-design/primitives";
import { ArrowLeft } from "lucide-react";
import { useFrameScheme } from "./frameScheme";
import { HeaderSlot } from "./MaterialTabs";
import capsule from "@/styles/header-capsule.module.css";
import f from "@/styles/detail-frame.module.css";

export function DetailFrame({
  title,
  subtitle = "",
  onBack,
  backLabel = "返回总览",
  actions,
  headingId,
  titleTag,
  children,
}: {
  title: string;
  /** 标题后面的小标签（如来自雷达的议题的「雷达」）；没有就不出现。 */
  titleTag?: ReactNode;
  /** 眉题。标题前面另有一段的页（会议页的计划时段）不写。 */
  subtitle?: string;
  /** 页头左端那颗圆的返回（读屏名称「返回总览」）。 */
  onBack: () => void;
  /** 信号阅读页返回当前列表，其他详情返回总览。 */
  backLabel?: string;
  /** 标题前面那一段、胶囊右端那一样、页头右边单独那一颗。 */
  actions?: ReactNode;
  /** 宿主要用标题给自己命名时传进来（aria-labelledby）；不传就自己生成一个。 */
  headingId?: string;
  /** 页头下面的正文。 */
  children?: ReactNode;
}) {
  const generated = useId();
  const heading = headingId ?? generated;
  const [tools, setTools] = useState<HTMLElement | null>(null);
  // 页头实际多高写进阅读页的 --detail-head-h：新首页里标题折行、页头长高时，键盘定位照它让开（header-capsule.module.css）。
  const head = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = head.current;
    const reader = header?.parentElement;
    if (!header || !reader) return;
    const measure = () => reader.style.setProperty("--detail-head-h", `${header.offsetHeight}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return (
    <TianshuTheme theme={useFrameScheme()} className={`${f.frame} ${capsule.scope}`}>
      <div className={`ts-detail ${f.reader}`}>
        <header ref={head} className="ts-detail-header">
          <div className="ts-row ts-between">
            <Button variant="ghost" onPress={onBack} data-close-view>
              <ArrowLeft size={18} />
              {backLabel}
            </Button>
            <div ref={setTools} data-header-tools />
            {actions}
          </div>
          <p className="ts-eyebrow">{subtitle}</p>
          <h1 id={heading}>{title}{titleTag}</h1>
        </header>
        <HeaderSlot.Provider value={{ element: tools }}>{children}</HeaderSlot.Provider>
      </div>
    </TianshuTheme>
  );
}
