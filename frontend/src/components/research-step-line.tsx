"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";
import type { ResearchStep } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 「这一轮研究此刻在哪一步、已经跑了多久」——**六处屏幕共用的同一行字。**
 *
 * ## 为什么是一个组件
 *
 * 这句话要出现在提请台卡面、潜在议题详情、首页议题行、议题清单、报告栏空态、判断板
 * 空态六个地方。抄六份的下场是可预见的：其中一处哪天写成「已用时」，另一处仍是
 * 「已」，而一号位会以为那是两种不同的状态。措辞、秒表、动效在这里只存在一份。
 *
 * ## 为什么是一道从左往右的光，不是转圈
 *
 * 一轮深研一到三分钟，转圈到第九十秒就开始像卡住了 —— 它每一帧都长得一样，说不出
 * 「刚才和现在不同」。`.sweeping-text`（`globals.css`）是一道比字色亮一点的光从左扫到
 * 右，3.2 秒一趟：动的是**这行字本身**，所以它说的是「这句话还是真的」，而不是
 * 「你快看我」。动效被关掉时它退成一句纯小字（那边有 `prefers-reduced-motion` 的退路）。
 *
 * ## 秒表在客户端走
 *
 * 服务端只给起点（`startedAt`）。让服务端算秒数就得每秒轮一次才不跳字，而提请台一屏
 * 能挂十几张卡 —— 那是十几倍的请求换一个本地就能算的数。
 */

/**
 * 排一轮大概要等多久。**写死，不去算。**
 *
 * 真算一个数要看前面那一轮走到第几步、这一步历史上要多久 —— 而那份历史现在没有，算出来的
 * 是一个看着精确的猜测。写死一个粗的数，说的是「大概这么久」，他不会拿它去对表；给一个
 * 「预计 11 分 24 秒后开始」然后差出五分钟，比不给更糟。
 *
 * 15 分钟是 2026-09 那几轮决策题的实测量级（ISS-236 单跑约 19 分钟，ISS-208 类的自家题
 * 9–11 分钟）。它偏保守 —— 早开始不会有人抱怨，晚开始会。
 */
const QUEUE_ETA_MIN = 15;

export function ResearchStepLine({
  step,
  startedAt,
  queuePosition,
  fallback,
  className,
}: {
  /** 此刻在哪一步。没上报就没有 —— 那时用 `fallback` 那句话。 */
  step?: ResearchStep;
  /** 这一轮什么时候起的。有它才有「已 34 秒」。 */
  startedAt?: string;
  /**
   * 前面还有几轮（在跑的那一轮也算）。**给了它就写排队那一句，步骤和秒表一概不写** ——
   * 这一轮一次模型调用都还没发，写「第 1 步」或者「已 15 分钟」都是编的。
   */
  queuePosition?: number;
  /**
   * 没有步骤时说的那句话，各屏自己的名词（「预研进行中」/「深度研究还在装配」）。
   *
   * **不在这里编一个「第 1 步」当兜底**：没上报就是不知道，而「第 1 步」是一个会被
   * 当真的假事实 —— 他会等它走到第 2 步，而永远不会。
   */
  fallback: string;
  className?: string;
}) {
  const elapsed = useElapsed(startedAt);

  if (queuePosition !== undefined) {
    return (
      <span className={cn("sweeping-text", className)} aria-live="polite">
        {`排队中 · 前面还有 ${queuePosition} 轮 · 预计 ${queuePosition * QUEUE_ETA_MIN} 分钟后开始`}
      </span>
    );
  }

  const head = step ? `正在${step.label} · 第 ${step.no}/${step.total} 步` : fallback;

  return (
    <span className={cn("sweeping-text", className)} aria-live="polite">
      {elapsed === null ? head : `${head} · 已 ${formatDuration(elapsed)}`}
    </span>
  );
}

/**
 * 从 `startedAt` 起走的秒表。没有起点就返回 null —— **不退回 0 秒**，那会在屏幕上
 * 写出「已 0 秒」并且永远停在那儿。
 *
 * 计时器只在有起点时挂，所以这一行字不在跑的时候不会每秒唤醒一次 React。
 */
function useElapsed(startedAt?: string): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  if (!startedAt) return null;
  const t0 = Date.parse(startedAt);
  if (Number.isNaN(t0)) return null;
  return Math.max(0, Math.round((now - t0) / 1000));
}

/**
 * 「用时 2 分 41 秒」—— 跑完之后那半句。
 *
 * 落在报告和预研的元数据行尾（`参谋 · 对研究的解读 · 08-20 14:32 · 用时 1 分 48 秒`）。
 * 首页和清单上不写：那两处完成态只有一行，接上用时会把「已完成」这个结论挤到第二眼。
 *
 * `undefined` 时**整段不出现**，不写「用时未知」——老数据没有这个字段是常态，给每份
 * 老报告挂一句「未知」等于在屏幕上制造一排看起来像故障的东西。
 */
export function researchTookText(durationMs?: number): string | null {
  if (durationMs === undefined || durationMs <= 0) return null;
  return `用时 ${formatDuration(durationMs / 1000)}`;
}
