"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * 一句话一个字一个字地出来。
 *
 * 为什么值得写这一百行，而不是等答案整段 pop 出来：整段出现的时候，一号位读完第一行
 * 之前眼睛要先扫一遍整块文字找起点；一个字一个字出来的时候，他的目光从第一个字开始
 * 就在跟着走。这是「丝滑」这个词在这个产品里唯一真正的来源——不是过渡动画，是节奏。
 *
 * 三个决定：
 *
 * 1. **按时间算，不按帧算。** 每帧领到的额度是 `dt × 速度`，所以掉帧只会让下一帧多吐
 *    几个字，不会让整句话变慢。60fps 和 30fps 下读完同一句话的时间一样。
 * 2. **标点要停。** 句号后面停 ~250ms，逗号 ~110ms。真人念稿就是这样断的；匀速吐字
 *    读起来像仪表盘在刷数，不像有人在跟你说话。停顿写成「多花几个字的额度」，所以它
 *    和速度共用一套记账，不需要另一个计时器。
 * 3. **只在字数变了的时候 setState。** 55 字/秒下大约每秒 55 次渲染，只更新一个文本
 *    节点；React 扛得住，但没变还渲染就是白烧一帧。
 *
 * 真的接上 SSE 之后这个 hook 会被换成「按到达的分片渲染」，组件一行都不用改：它们
 * 拿到的一直是「现在该显示多少」。
 */

/** 字/秒。比人朗读快一点，比「一次性刷出来」慢很多。 */
const RATE = 55;

/** 标点后面的停顿，记成「额外花掉几个字的额度」。 */
const PAUSE: Record<string, number> = {
  "。": 14,
  "！": 14,
  "？": 14,
  "…": 12,
  "；": 8,
  "，": 6,
  "、": 4,
  "：": 6,
  "\n": 10,
};

export function useTypeIn(
  text: string,
  active: boolean,
  onDone?: () => void,
): { shown: string; typing: boolean } {
  // 「减少动效」是无障碍设置，不是偏好设置：勾了它的人看这个会难受。
  // 先无条件读它，再跟 `active` 合 —— 写成 `active && !usePrefers…()` 会让这个 hook
  // 在 `active` 是 false 的那些渲染里根本不执行，hook 顺序就不稳了。
  const reduced = usePrefersReducedMotion();
  const typeAt = active && !reduced;

  /*
   * 进度和它属于**哪句话**一起存。这样 `text` 一换，`count` 在渲染时就自己归零了 ——
   * 不然新句子的第一帧会拿上一句的 count 去 slice，闪出半句不属于它的话。
   */
  const [progress, setProgress] = useState({ of: text, count: 0 });
  const count = progress.of === text ? progress.count : 0;

  const finish = useRef(onDone);
  useEffect(() => {
    finish.current = onDone;
  });

  useEffect(() => {
    if (!typeAt) {
      // 这句话在屏幕上已经是完整的了，所以它已经「说完了」。历史消息（`active` 是
      // false）不算 —— 它从来没开始过，不该触发一次「刚说完」的回调。
      if (active) finish.current?.();
      return;
    }

    let raf = 0;
    let last = 0;
    let budget = 0;
    let i = 0;
    let fired = false;
    const done = () => {
      if (fired) return;
      fired = true;
      finish.current?.();
    };

    const step = (now: number) => {
      if (last === 0) last = now;
      // 切走标签页再切回来，dt 会是好几秒。夹一下，否则回来时整段瞬间吐完。
      const dt = Math.min(now - last, 120);
      last = now;
      budget += (dt / 1000) * RATE;

      let moved = false;
      while (budget >= 1 && i < text.length) {
        const ch = text[i];
        i += 1;
        budget -= 1;
        moved = true;
        const pause = PAUSE[ch];
        // 结尾的标点不停：那一停发生在光标消失之后，读起来像卡住了。
        if (pause && i < text.length) {
          budget -= pause;
          break;
        }
      }

      if (moved) setProgress({ of: text, count: i });

      if (i < text.length) raf = requestAnimationFrame(step);
      else done();
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, typeAt, active]);

  return {
    shown: typeAt ? text.slice(0, count) : text,
    typing: typeAt && count < text.length,
  };
}

/* -------------------------------------------------------------------------- */

const REDUCED = "(prefers-reduced-motion: reduce)";

/**
 * 系统的「减少动效」开关。
 *
 * 走 `useSyncExternalStore` 而不是「effect 里读一次 matchMedia 再 setState」：服务端
 * 渲染不知道这个值，客户端知道 —— 这两个快照本来就该不一样，而这正是这个 API 存在的
 * 理由。顺带它还跟着系统设置实时变，用户在演示中途改了设置也不用刷新。
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, getReduced, () => false);
}

function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getReduced() {
  return window.matchMedia(REDUCED).matches;
}
