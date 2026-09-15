import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 一页。
 *
 * 各页面共用一个容器：一条上限宽度、一个标题块、一套小节标题。顶上那一行已经回答了
 * 「我在哪、怎么回去」，所以这里不再有第二层常驻标题栏 —— 标题是**内容**，它跟着内容
 * 一起滚走。
 *
 * ## 它现在是一张纸，摆在桌面上
 *
 * 起因是一张空状态的截图：一句「今天没有值得您看的」悬在通屏的近白里，上不着天
 * 下不着地。原因不在那一句话 —— 是这一层容器只管宽度和留白，从来没有面。有卡片的
 * 页面靠卡片糊过去了，没卡片的页面（会前准备、会后确认、文档库）直接露馅。
 *
 * 所以桌面压暗一档、这一层铺上 `--surface`（`.page-sheet`，见 globals.css）。
 * 两层结构因此各管一件事：
 *
 *   外层  桌面留出来的边（`px-4 pt-4 pb-10 sm:px-6`）。纸的四周得有桌子。
 *   内层  纸本身 —— 上限宽度、圆角、发丝边、内边距都在这里。
 *
 * **阅读宽度一个像素没变**：`max-w-[780px]` 从外层挪到了纸上，纸的 `px-6` 还是 24，
 * 正文列照旧是 732px。改的是纸外面那一圈，不是纸里面那一行字。
 *
 * `width` 三档。`reading` 是单列阅读宽度（待定事项、议题列表、会前准备、会后确认），
 * `wide` 给要并排两列的页面。`full` 是**主页和会议台**：那两屏自己就是排好的一版
 * （雷达窗、三栏台面），再套一张纸就是两层面相叠 —— 所以它们不进纸，直接坐在桌上。
 * 那两屏的正文因此仍然量的是桌面的对比度（`ink-faint` 在 #f1f1f3 上 4.70:1，过线）。
 *
 * 换页的淡入（`animate-panel`）靠 React 重新挂载触发 —— 页面是路由，路由一换整棵子树
 * 就是新的。这是「不许有硬切」那条验收标准的落点。它挂在外层：纸和它周围的桌边是
 * 一起淡进来的，纸自己不单独动。
 */
export function Panel({
  children,
  className,
  width = "reading",
}: {
  children: ReactNode;
  className?: string;
  width?: "reading" | "wide" | "full";
}) {
  if (width === "full") {
    return (
      <div className={cn("animate-panel mx-auto w-full max-w-[1600px] px-6 pt-8 pb-24", className)}>
        {children}
      </div>
    );
  }

  return (
    <div className="animate-panel px-4 pt-4 pb-10 sm:px-6">
      <div
        className={cn(
          "page-sheet mx-auto w-full px-6 pt-8 pb-16",
          width === "reading" ? "max-w-[780px]" : "max-w-[1280px]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 页面的标题块。
 *
 * `eyebrow` 是这一页在公司里的坐标（环节、编号、日期），`title` 是它是什么，`sub` 是
 * 一句人话。三层里最响的只有一个 —— title。
 */
export function PanelHead({
  eyebrow,
  title,
  sub,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6", className)}>
      {eyebrow ? <div className="meta mb-1.5 text-ink-faint">{eyebrow}</div> : null}
      <div className="flex items-start gap-3">
        <h1 className="min-w-0 flex-1 text-lg font-medium tracking-[-0.01em] text-ink">
          {title}
        </h1>
        {actions ? <div className="flex flex-none items-center gap-1.5">{actions}</div> : null}
      </div>
      {sub ? <p className="mt-2 text-sm text-ink-muted">{sub}</p> : null}
    </header>
  );
}

/** 页面里的一个小节标题。全站只有这一种。 */
export function PanelSection({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-7 first:mt-0", className)}>
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        {count !== undefined ? <span className="meta text-ink-faint">{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * 空。
 *
 * 空状态在这个产品里是一等结果，不是失败：「今天没有值得您看的」是合格输出。所以它
 * 有正经的排版，不是一行灰字。
 */
export function PanelEmpty({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children?: ReactNode;
}) {
  return (
    /* 空状态是一个合格结果，但它不是一个要被拿起来的东西 —— 一块淡底，没有厚度。 */
    <div className="rounded-lg bg-neutral-wash px-5 py-6 [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)]">
      <p className="text-base text-ink">{title}</p>
      {note ? <p className="mt-1.5 text-sm text-ink-muted">{note}</p> : null}
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}
