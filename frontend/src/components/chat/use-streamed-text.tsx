"use client";

import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/components/chat/use-type-in";

/**
 * 把一段**还在长**的正文按稳定的速度放出来。
 *
 * ## 它修的是哪一种卡
 *
 * 上游给的分片不是匀速的：模型那一头按 token 批量吐，网络再攒一层，落到屏幕上是「停一
 * 下、蹦出二十个字、再停一下」。每一次蹦都是一次版面重排，读的人的眼睛刚跟上第一行就
 * 被下面新长出来的一段推走 —— 这就是「一卡一卡」的来源。它不是掉帧，是**到达的节奏**
 * 本身不均匀，所以调渲染性能修不掉。
 *
 * 这里在到达和显示之间垫一层：到的照收进缓冲，屏幕按自己的节奏往外放。
 *
 * ## 为什么不是固定速度
 *
 * 固定速度会在两头各错一次：模型比它快的时候越拖越远（一段两千字的回复能落后十几秒，
 * 而屏幕上那枚光标还在慢慢爬），比它慢的时候又变成一顿一顿地等。
 *
 * 所以速度跟着**积压**走：手上压了多少还没放出去的字，就按「在 `LAG_MS` 之内放完」
 * 来定这一帧的额度，并且不低于 `BASE`。于是它永远只落后小半秒 —— 足够把到达的抖动
 * 抹平，又不会让人觉得屏幕比模型慢。
 *
 * ## 和 `useTypeIn` 的分工
 *
 * `useTypeIn` 放的是一句**已经写完**的话（标点处还要停顿，那是朗读的节奏）。这一份放的
 * 是一段正在写的话，不做停顿：一段真在生成的文字里，停顿的位置该由模型的节奏决定，
 * 我们再叠一层假的断句，读起来会和它自己的节奏打架。
 */

/** 追平积压的目标时间。半秒 —— 抹得平到达抖动，又看不出屏幕比模型慢。 */
const LAG_MS = 500;

/** 没有积压时的下限速度，字/秒。比人朗读快一点（同 `useTypeIn` 的 `RATE`）。 */
const BASE = 55;

export function useStreamedText(buffer: string, active: boolean): string {
  const reduced = usePrefersReducedMotion();
  const [count, setCount] = useState(0);

  /*
   * 缓冲放 ref 里：下面那个 effect 只该在「开始 / 结束」时重挂，不该每来一个分片就重挂
   * 一次 —— 重挂会把 rAF 循环拆了重建，而那正是它要抹平的那种抖动。
   */
  const buf = useRef(buffer);
  /*
   * 同步走 effect，不在渲染里写 ref。渲染里写等于让同一次渲染有副作用，而这个 ref 只被
   * 下面那个 rAF 循环读 —— 慢一帧对它没有任何影响（它本来就是按帧配额往外放的）。
   */
  useEffect(() => {
    buf.current = buffer;
  }, [buffer]);

  /*
   * 进度同时存一份 ref。**不在 `setCount(c => …)` 的那个函数里记账** —— 开发模式下
   * React 会把 updater 跑两遍来暴露不纯的写法，而这里的额度是攒在闭包变量上的，跑两遍
   * 就等于速度翻倍。所以算在外面，state 只用来触发渲染。
   */
  const at = useRef(0);
  const put = (n: number) => {
    at.current = n;
    setCount(n);
  };

  useEffect(() => {
    /*
     * 不在说话的时候不转。这个 hook 挂在整栏对话上，一直转的话，一个空着的对话框也会
     * 每帧唤醒一次合成器 —— 那是一整块屏幕在为一件没有发生的事耗电。
     *
     * 勾了「减少动效」的那一档也不转：那时到多少给多少（见下面的返回）。
     */
    if (reduced || !active) return;

    let raf = 0;
    let last = 0;
    let budget = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!last) {
        last = t;
        return;
      }
      const dt = (t - last) / 1000;
      last = t;
      const total = buf.current.length;
      /*
       * 换了一段话就归零。判的是**变短了**（下一轮从空串起步，见 `chat-pane.tsx` 的
       * `setStreaming("")`）—— 不能判「变了」：正在流的那一段每一帧都在变，判「变了」
       * 等于每一帧都归零，屏幕上一个字也出不来。
       *
       * 归在这里而不是一个 effect 里：effect 里 setState 会多滚一轮渲染，而这件事本来
       * 就该由这个循环自己发现（它是唯一一个按帧盯着缓冲的人）。
       */
      if (at.current > total) {
        at.current = 0;
        budget = 0;
      }
      if (at.current >= total) {
        // 追平了，额度不许攒着 —— 攒着的话下一批一到会「啪」地全放出来，那正是这一层
        // 要消掉的东西。
        budget = 0;
        return;
      }
      const backlog = total - at.current;
      budget += dt * Math.max(BASE, backlog / (LAG_MS / 1000));
      if (budget < 1) return;
      const step = Math.floor(budget);
      budget -= step;
      put(Math.min(total, at.current + step));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, active]);

  /*
   * 说完了就把整段给全，**算出来的，不是再 setState 一次**。
   *
   * 不给全的话，最后那一小截会在「说完了」之后还在慢慢爬，而这一栏此刻已经把这一段换成
   * 落库那一条了 —— 屏幕上表现成同一段话先停住、再整个跳到完整版。
   *
   * 「减少动效」那一档同理：到多少给多少。
   */
  if (reduced || !active) return buffer;
  return buffer.slice(0, Math.min(count, buffer.length));
}
