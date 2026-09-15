"use client";

import { ArrowDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/components/chat/use-type-in";
import { cn } from "@/lib/utils";

/**
 * 「跟着底走，但他往上翻的时候就别跟了」。
 *
 * ## 上一版为什么不行
 *
 * 上一版是一句话：来了新东西就 `scrollTop = scrollHeight`。于是参谋还在写的那一两分钟
 * 里，他**没法停在任何地方读**：往上翻两屏去看刚才那一段，下一个分片一到就被拽回底部，
 * 一秒好几次。而他往上翻这个动作本身已经把话说完了 —— 那是「我现在要读的不是最新的那
 * 一行」。所以这里认的是那个动作：他一往上翻就松开，下面继续默默地写。
 *
 * 松开之后要有一条回去的路，不然「跟到底」这件事就从自动变成了没有。那条路是右下角
 * 一枚圆键（`JumpToBottom`），按一下回到底并且重新跟上。
 *
 * ## 怎么判「他在底部」
 *
 * 按距离，不按等号。`scrollHeight - scrollTop - clientHeight` 在浏览器缩放、亚像素行高
 * 和 flex 布局下几乎从不精确等于 0，写等号的结果是这个功能在某些机器上永远处于「他不在
 * 底部」，于是从来不自动跟。留 48px 的余量：那不到一行半，肉眼上仍然是「他就在底部」。
 *
 * ## 那个 ref 由这里造，不由外面递进来
 *
 * 这个 hook 要**写**滚动位置。写一个外面递进来的 ref，等于在渲染之后改调用方手上的东西
 * —— React Compiler 直接把它判成不许做的事，而它是对的：那样一来「谁拥有这个元素」就没有
 * 答案了。所以 ref 在这里造、交出去给别人读（导航条、划词引用都只读它）。
 *
 * ## 自己滚的那一下不需要额外的闩
 *
 * 我们把它滚到底之后，滚动事件照样触发，而那一刻算出来的「在底部」是 true —— 状态和
 * 事实一致，不需要一个「这次是我自己滚的」标记。标记那条路要处理平滑滚动途中的一串
 * 中间事件，而那串事件里每一个的「在底部」都是 false。
 */

/** 离底多近算「他在底部」。不到一行半。 */
const NEAR = 48;

export function useStickToBottom(
  /**
   * 内容变了的信号。变一次就跟一次 —— 传一个能代表「屏幕上多了字」的值（轮数 + 正在
   * 写的那段长度）。传对象或数组会让这个 effect 每渲染都跑一遍。
   */
  signal: string | number,
): {
  scroller: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  scrollToBottom: (smooth?: boolean) => void;
} {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  /*
   * 跟不跟这件事存在 ref 里，不存在 state 里：下面那个 effect 每来一批字就跑一次，
   * 读 state 的话它要把 `atBottom` 放进依赖，于是每次滚动都重挂一遍 effect。
   */
  const stick = useRef(true);
  const reduced = usePrefersReducedMotion();

  const scrollToBottom = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({
      top: el.scrollHeight,
      // 「减少动效」是无障碍设置：勾了它的人不该被一段两屏长的平滑滚动甩一下。
      behavior: smooth && !reduced ? "smooth" : "auto",
    });
  };

  // 他滚一下，就重新问一次「还在底部吗」。往上翻 = 松开；自己翻回底部 = 重新跟上。
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR;
      stick.current = near;
      setAtBottom(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    /*
     * **挂上就完了，不在这里先问一次。**
     *
     * 问一次看着更稳妥，实际是把初次的跟随整个废掉：这一栏的历史是一上来就在的（SWR
     * 那一份已经在手上），所以挂载那一刻内容已经满了、位置在最顶上 —— 这一问算出来的
     * 是「他不在底部」，于是下面那个跟随 effect 当场返回，页面停在第一轮对话上，而他
     * 要读的是最后一轮。2026-08-31 实测到的就是这个。
     *
     * 不问也不会漏：初值本来就是「在底部」（这一栏刚打开，还没有人往上翻过），而第一次
     * 跟随滚下去之后浏览器自己会发一个 scroll 事件，那时这两个值就对上了。
     */
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // 内容长了。跟着的时候才跟 —— 松开的那一档下面默默地写，屏幕一个像素都不动。
  useEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [signal]);

  return { scroller, atBottom, scrollToBottom };
}

/**
 * 回到底那枚圆键。**只在松开的时候出现** —— 已经在底部时它指向他脚下，那时它是一颗
 * 永远亮着、按下去什么也不会发生的键。
 *
 * 位置压在对话区右下角内侧，不占版面：它是一条临时的路，不是这一栏的常驻控件。
 */
export function JumpToBottom({
  show,
  onClick,
  className,
}: {
  show: boolean;
  onClick: () => void;
  className?: string;
}) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="回到最新"
      title="回到最新"
      className={cn(
        "animate-fade absolute bottom-4 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center",
        "rounded-full border border-hairline bg-paper text-ink-muted shadow-sm",
        "transition-colors duration-fast ease-swift hover:border-hairline-strong hover:text-ink",
        className,
      )}
    >
      <ArrowDown className="size-4" aria-hidden />
    </button>
  );
}
