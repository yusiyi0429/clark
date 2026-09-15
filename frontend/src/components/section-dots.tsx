"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 一栏里的几个圆点 —— 这一栏有哪几段、现在在哪一段、点一下跳过去。
 *
 * 它存在的理由是**这一栏会变得很长，而长度是他自己按出来的**：预研报告原文展开、他贴
 * 进来的那一整篇原文展开，两个折叠都打开之后，「它动摇哪条判断」和「升级深研会去查
 * 这些」被推到七八屏之下，而那两段恰恰是他做那个决定要看的。滚轮找不到它们 —— 屏幕上
 * 全是等长的灰段落，没有地标。
 *
 * ## 为什么是点，不是一列标题
 *
 * 一列文字目录要占掉四五个字的宽度，而这一栏只有 26rem，正文本来就紧。点只占一条
 * 12px 的槽，悬停时才把那一段的名字摊开 —— 导航是临时动作，不该常驻在版面上。
 *
 * ## 不满三段、或者根本没滚出来，它就不出现
 *
 * 两个条件都要：三个点的导航比直接滚还慢；而没溢出的时候，那几段全在一屏里，点它等于
 * 原地不动 —— 屏幕上多一列不改变任何东西的记号，是在花版面买一个「看起来有功能」。
 *
 * 折叠一开一合会改变内容高度，所以量是持续量的（`ResizeObserver` 盯每一段），不是挂载
 * 时量一次 —— 量一次的话，他展开原文之后点还是不出来，而那正是最需要它的时刻。
 */
export type Section = { id: string; label: string };

export function SectionDots({
  scroller,
  sections,
}: {
  /** 会滚的那个容器。点要挂在它内侧的左边缘，所以由调用处传进来。 */
  scroller: React.RefObject<HTMLDivElement | null>;
  sections: Section[];
}) {
  const [active, setActive] = useState<string | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const enough = sections.length >= 3;

  // 这一栏此刻到底滚不滚得动。`scrollHeight - clientHeight` 而不是「段数够多」——
  // 段数和高度没有关系：四段全折叠起来仍然只有一屏。
  useEffect(() => {
    const root = scroller.current;
    if (!root || !enough) return;
    const measure = () => setOverflowing(root.scrollHeight - root.clientHeight > 120);
    measure();
    const ro = new ResizeObserver(measure);
    // 容器自己的高度（窗口缩放）和每一段的高度（折叠开合）都要盯 —— 只盯容器的话，
    // 展开原文这个动作量不到，因为容器的盒子一点没变。
    ro.observe(root);
    for (const child of Array.from(root.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [scroller, enough, sections]);

  /*
   * 滚到哪了就填哪一颗。用 IntersectionObserver 而不是 scroll 事件：后者每帧要把所有
   * 锚点量一遍（`getBoundingClientRect`），而这一栏最长的时候有七八屏。
   * 同 `ThreadRail`。
   */
  useEffect(() => {
    const root = scroller.current;
    if (!root || !enough || !overflowing) return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) setActive(hit.target.id);
      },
      // 上边缘往下收 15%、下边缘往上收 70%：判定线落在视口偏上的位置，读到一段的开头
      // 就算「在这一段」，而不是等它滚到正中间。
      { root, rootMargin: "-15% 0px -70% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [scroller, sections, enough, overflowing]);

  if (!enough || !overflowing) return null;

  return (
    <nav
      aria-label="跳到这一页的某一段"
      className="absolute top-0 bottom-0 left-0 z-10 flex w-7 flex-col items-center justify-center gap-3"
    >
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          title={s.label}
          // 填满的那一颗在读屏器里也要是「当前这一段」—— 只靠大 2px 和深一档的颜色说，
          // 那句话只对看得见的人说了。
          aria-current={active === s.id ? "true" : undefined}
          onClick={() =>
            document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
          }
          className="group/dot relative flex size-3 items-center justify-center"
        >
          <span
            className={cn(
              "size-1 rounded-full transition-all duration-fast",
              active === s.id
                ? "size-1.5 bg-ink"
                : "bg-hairline-strong group-hover/dot:bg-ink-faint",
            )}
          />
          {/* 悬停才摊开那一段的名字。压在正文上方，不挤版面。 */}
          <span className="pointer-events-none absolute top-1/2 left-full z-20 ml-1 hidden -translate-y-1/2 rounded-md border border-hairline-strong bg-surface px-2 py-1 whitespace-nowrap shadow-e2 group-hover/dot:block">
            <span className="meta text-ink">{s.label}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}
