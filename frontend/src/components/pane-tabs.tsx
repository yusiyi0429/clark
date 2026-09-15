"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 一栏正文上面浮着的那排页签 —— **一条悬浮的磨砂长条**，压在正文上面。
 *
 * 上一版它是一条 44px 高的 `<header>`：占满整栏宽、底下一条发丝线，把那一栏切成
 * 「上面一格标签、下面一块正文」。而它承载的是一个**开关**，不是一段内容 —— 一个开关
 * 不需要一条通栏的横槽，更不该在一页专门为正文腾地方的屏幕上常驻 44px。
 *
 * 现在它不占流里的高度（`absolute`）：正文从那一栏的最顶上开始，滚起来从这条长条**底下
 * 穿过去**。磨砂（`.floating`）是这件事的前提 —— 字直接压在半透明底上会互相干扰，
 * 糊过的底才读得出「那一层在上面」。第一行的位置由 `--pane-inset-top` 让出来，由用它的
 * 那一页给（议题研究页是 3.5rem）。
 *
 * ## 里面是一枚滑块，不是几个按钮各自的底
 *
 * 选中那一格的底是**一个会滑的方块**（`thumb`），位置和宽度按选中那颗按钮量出来。
 * 几个按钮各自开关自己的底色，切换时是「这边灭、那边亮」；一枚滑块滑过去，说的是
 * 「同一个选择在几个取值之间移动」—— 而这一排正是一个单选。
 *
 * 量的是 `offsetLeft/offsetWidth`（不是 `getBoundingClientRect`）：这条长条自己可以
 * 横向滚（五项以上装不下），而 offset 系是相对这条长条的内容盒的，滑块跟着内容一起
 * 滚，不需要把 scrollLeft 再算一遍。
 *
 * `signature` 是重新量的信号：选中项换了要量，页签的**数量或宽度**变了也要量
 * （多跑一条链路多一枚页签、已确认条数从 2 变 3 会撑宽「当前判断」那一格）。用一个
 * 字符串而不是 `children` 作依赖 —— children 每次渲染都是新数组，那等于每渲染一遍
 * 就强制一次 layout。
 *
 * ## 为什么它住在 `components/` 而不是议题研究那一页里
 *
 * 开会那一页（`_views/meeting-live-view.tsx`）要的是**同一枚**滑块：一号位在议题研究页
 * 上用这排页签换报告，开会时换的是同一批东西，手感必须是同一个。抄一份过去的代价不是
 * 多几十行 —— 是那两处哪天一处改了滑块的时长或者磨砂的档位，而同一个控件在同一个产品
 * 里成了两个。
 */
export function PaneTabBar({
  signature,
  className,
  children,
}: {
  signature: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <PaneTabDock className={className}>
      <PaneTabGroup signature={signature}>{children}</PaneTabGroup>
    </PaneTabDock>
  );
}

/**
 * 悬浮那一层，只管定位和居中。**本身不接鼠标** —— 它横跨整栏，接了就等于在正文上盖了
 * 一条看不见的挡板；长条自己把事件收回来。
 *
 * 单独抽出来是因为**一行里可能不止一条长条**：开会那一页上，选哪件议题和选哪条链路是
 * 两个并列的单选，各自要一枚自己的滑块。摞成两行的代价是正文第一行往下让 6.25rem ——
 * 而它们并排只要 3.5rem，省下来的正好是一条判断的高度。
 */
export function PaneTabDock({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center gap-2 px-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 一条长条 —— 一枚滑块、一个单选。几条并排时各管各的（见 `PaneTabDock`）。 */
export function PaneTabGroup({
  signature,
  children,
}: {
  signature: string;
  children: React.ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => {
      const on = el.querySelector<HTMLElement>('[aria-pressed="true"]');
      const next = on ? { left: on.offsetLeft, width: on.offsetWidth } : null;
      /*
       * 同一个位置就把上一次那个对象还回去。不然每次量完都是一个新对象 —— 而
       * ResizeObserver 的回调本身可能由这次渲染触发，那就是一个自己喂自己的循环。
       */
      setThumb((prev) =>
        prev && next && prev.left === next.left && prev.width === next.width ? prev : next,
      );
    };
    measure();
    /* 字体落下来、窗口变宽、这一栏被挤窄，每一样都会挪动那颗按钮。 */
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [signature]);

  return (
    /* `min-w-0`：并排两条时，谁都不许靠「我内容有多宽就多宽」把另一条挤出屏幕 ——
       装不下的那一条自己横向滚（滑块量的是 offset 系，跟着内容一起滚，见上）。 */
    <div
      ref={wrap}
      className="floating scroll-slim scroll-x-only pointer-events-auto relative flex min-w-0 max-w-full items-center gap-0.5 rounded-full p-1"
    >
        {/* 滑块。`transition-[left,width]` 走的是这两个数，不是 transform —— 宽度本身
            要跟着变（页签一个三字一个五字），而 transform 缩放会把它的圆角一起拉扁。 */}
        {thumb ? (
          <span
            aria-hidden
            style={{ left: thumb.left, width: thumb.width }}
            className="absolute top-1 bottom-1 rounded-full bg-neutral-wash transition-[left,width] duration-base ease-swift"
          />
        ) : null}
      {children}
    </div>
  );
}

export function PaneTab({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  /** 这一栏还没有正文，摆着但点不动（`IssueReport.pending`）。 */
  disabled?: boolean;
  /** 点不动的那一栏为什么点不动。原话来自产出那一轮。 */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        /* `relative` 是为了压在滑块上面：滑块是绝对定位的兄弟，静态元素会被它盖住。
           选中那一格自己**没有底** —— 底是那枚滑块的（见 `PaneTabBar`）。 */
        "meta relative whitespace-nowrap rounded-full px-3 py-1 font-medium transition-colors duration-fast ease-swift",
        active ? "text-ink" : "text-ink-faint hover:text-ink-muted",
        // 点不动的那一栏不给 hover：手感上答的是「这儿能点」，而它不能。
        disabled && "cursor-default text-ink-faint/60 hover:text-ink-faint/60",
      )}
    >
      {children}
    </button>
  );
}
